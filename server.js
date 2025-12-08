require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { uploadImage, deleteImage } = require('./config/cloudinary');

const { User, Store, Product, Order, sequelize } = require('./models');
const { testConnection } = require('./config/database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
  },
  transports: ['polling', 'websocket'],
  allowUpgrades: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  allowEIO3: true
});

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados intentos de login. Intenta en 15 minutos.' }
});

const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { error: 'Demasiadas solicitudes. Intenta más tarde.' }
});

app.use('/api/', generalLimiter);

const userSockets = new Map();

function notifyUser(userId, notification) {
  const socketId = userSockets.get(userId.toString());
  if (socketId) {
    io.to(socketId).emit('notification', notification);
    console.log(`📬 Notificación enviada a usuario ${userId}:`, notification.title);
    return true;
  }
  return false;
}

function notifyRole(role, notification) {
  User.findAll({ where: { role } }).then(users => {
    users.forEach(user => notifyUser(user.id, notification));
  });
}

function notifyMultiple(userIds, notification) {
  userIds.forEach(userId => notifyUser(userId, notification));
}

// Configuración de multer para memoria (Cloudinary)
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Solo se permiten imágenes (JPG, PNG, WEBP)'), false);
  }
};

const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 3000;
const COMMISSION_RATE = parseFloat(process.env.COMMISSION_RATE) || 0.20;
const SERVICE_FEE = parseFloat(process.env.SERVICE_FEE) || 10;

if (!JWT_SECRET || JWT_SECRET === 'tu-secreto-super-seguro-CAMBIAR-EN-PRODUCCION') {
  console.error('❌ ERROR: JWT_SECRET no configurado correctamente en .env');
  process.exit(1);
}

const ORDER_STATES = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  PREPARING: 'preparing',
  READY: 'ready',
  PICKED_UP: 'picked_up',
  ON_WAY: 'on_way',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled'
};

const STATE_PERMISSIONS = {
  pending: {
    canUpdate: ['store_owner', 'client'],
    nextStates: ['accepted', 'cancelled']
  },
  accepted: {
    canUpdate: ['store_owner'],
    nextStates: ['preparing', 'cancelled']
  },
  preparing: {
    canUpdate: ['store_owner'],
    nextStates: ['ready', 'cancelled']
  },
  ready: {
    canUpdate: ['driver'],
    nextStates: ['picked_up', 'cancelled']
  },
  picked_up: {
    canUpdate: ['driver'],
    nextStates: ['on_way']
  },
  on_way: {
    canUpdate: ['driver'],
    nextStates: ['delivered']
  },
  delivered: {
    canUpdate: [],
    nextStates: []
  },
  cancelled: {
    canUpdate: [],
    nextStates: []
  }
};


// ========================================
// FUNCIONES DE CÁLCULO DE DISTANCIA Y TARIFA
// ========================================

/**
 * Calcula distancia entre dos puntos GPS usando fórmula Haversine
 * @param {number} lat1 - Latitud punto 1
 * @param {number} lon1 - Longitud punto 1
 * @param {number} lat2 - Latitud punto 2
 * @param {number} lon2 - Longitud punto 2
 * @returns {number} - Distancia en kilómetros
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const straightDistance = R * c;
  const roadFactor = 1.3;
  return straightDistance * roadFactor;
}

/**
 * Calcula tarifa de entrega basada en distancia (Radio máximo: 8 km)
 */
function calculateDeliveryFee(distance) {
  let deliveryFee;
  if (distance <= 2) {
    deliveryFee = 30;
  } else if (distance <= 4) {
    deliveryFee = 40;
  } else if (distance <= 6) {
    deliveryFee = 55;
  } else if (distance <= 8) {
    deliveryFee = 70;
  } else {
    return null;
  }
  const driverEarnings = deliveryFee * 0.8;
  const platformCut = deliveryFee * 0.2;
  return {
    deliveryFee,
    driverEarnings,
    platformCut,
    distance: parseFloat(distance.toFixed(2))
  };
}

/**
 * Estima tiempo de entrega basado en distancia
 */
function estimateDeliveryTime(distance) {
  const travelTime = (distance / 15) * 60;
  const preparationTime = 10;
  return Math.ceil(travelTime + preparationTime);
}

// ========================================

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token inválido' });
    }
    req.user = user;
    next();
  });
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, phone, role, vehicle, license, address, inePhoto, vehiclePhoto } = req.body;

    if (!email || !password || !name || !phone || !role) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Email inválido' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'El email ya está registrado' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const userData = {
      email,
      password: hashedPassword,
      name,
      phone,
      role
    };

    if (role === 'driver') {
      userData.vehicle = vehicle;
      userData.license = license;
      userData.inePhoto = inePhoto;
      userData.vehiclePhoto = vehiclePhoto;
      userData.available = false;
      userData.approved = false;
    } else if (role === 'client') {
      userData.address = address;
    }

    const newUser = await User.create(userData);

    const token = jwt.sign(
      { id: newUser.id, email: newUser.email, role: newUser.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    if (role === 'driver') {
      notifyRole('admin', {
        title: 'Nuevo conductor registrado',
        message: `${name} se ha registrado como conductor`,
        type: 'info',
        timestamp: new Date()
      });
    }

    const userResponse = newUser.toJSON();
    delete userResponse.password;

    res.status(201).json({ 
      message: 'Usuario registrado exitosamente',
      token,
      user: userResponse
    });
  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({ error: 'Error al registrar usuario', details: error.message });
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña son requeridos' });
    }

    const user = await User.findOne({ where: { email } });

    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    if (user.role === 'driver' && !user.approved) {
      return res.status(403).json({ 
        error: 'Tu cuenta de conductor está pendiente de aprobación',
        pending: true
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    const userResponse = user.toJSON();
    delete userResponse.password;

    res.json({ 
      message: 'Login exitoso',
      token,
      user: userResponse
    });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error al iniciar sesión', details: error.message });
  }
});


// ============================================
// RUTAS DE RECUPERACIÓN DE CONTRASEÑA
// Agregar después de la ruta de login (después de línea ~350)
// ============================================

// Almacenamiento temporal de códigos de recuperación (en producción usar Redis)
const resetCodes = new Map();

// Generar código de 6 dígitos
function generateResetCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// POST /api/auth/forgot-password - Solicitar código de recuperación
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { phone, email } = req.body;

    if (!phone && !email) {
      return res.status(400).json({ error: 'Debes proporcionar teléfono o email' });
    }

    // Buscar usuario por teléfono o email
    const whereClause = phone ? { phone } : { email };
    const user = await User.findOne({ where: whereClause });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Generar código de 6 dígitos
    const code = generateResetCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

    // Guardar código
    const identifier = phone || email;
    resetCodes.set(identifier, {
      code,
      userId: user.id,
      expiresAt,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role
      }
    });

    // TODO: En producción, enviar código por SMS/Email
    // Por ahora, solo lo generamos y el admin puede verlo
    console.log(`🔑 Código de recuperación generado para ${user.name}: ${code}`);

    // En desarrollo, devolver el código
    const isDevelopment = process.env.NODE_ENV !== 'production';
    
    res.json({
      message: 'Código de recuperación generado. Contacta al administrador para obtenerlo.',
      ...(isDevelopment && { devCode: code }) // Solo en desarrollo
    });

  } catch (error) {
    console.error('Error en forgot-password:', error);
    res.status(500).json({ error: 'Error al generar código de recuperación' });
  }
});

// POST /api/auth/reset-password - Cambiar contraseña con código
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { phone, email, code, newPassword } = req.body;

    if (!code || !newPassword) {
      return res.status(400).json({ error: 'Código y nueva contraseña son requeridos' });
    }

    if (!phone && !email) {
      return res.status(400).json({ error: 'Debes proporcionar teléfono o email' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    // Buscar código
    const identifier = phone || email;
    const resetData = resetCodes.get(identifier);

    if (!resetData) {
      return res.status(400).json({ error: 'Código inválido o expirado' });
    }

    // Verificar código
    if (resetData.code !== code) {
      return res.status(400).json({ error: 'Código incorrecto' });
    }

    // Verificar expiración
    if (new Date() > new Date(resetData.expiresAt)) {
      resetCodes.delete(identifier);
      return res.status(400).json({ error: 'Código expirado. Solicita uno nuevo.' });
    }

    // Buscar usuario
    const user = await User.findByPk(resetData.userId);
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Cambiar contraseña
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await user.update({ password: hashedPassword });

    // Eliminar código usado
    resetCodes.delete(identifier);

    console.log(`✅ Contraseña cambiada exitosamente para ${user.name}`);

    res.json({
      message: 'Contraseña actualizada exitosamente',
      success: true
    });

  } catch (error) {
    console.error('Error en reset-password:', error);
    res.status(500).json({ error: 'Error al cambiar contraseña' });
  }
});

// GET /api/admin/reset-codes - Ver códigos activos (solo admin)
app.get('/api/admin/reset-codes', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo administradores pueden ver códigos' });
    }

    // Limpiar códigos expirados
    const now = new Date();
    for (const [key, value] of resetCodes.entries()) {
      if (now > new Date(value.expiresAt)) {
        resetCodes.delete(key);
      }
    }

    // Convertir Map a Array
    const codes = Array.from(resetCodes.values()).map(data => ({
      code: data.code,
      expiresAt: data.expiresAt,
      name: data.user.name,
      phone: data.user.phone,
      email: data.user.email,
      role: data.user.role
    }));

    res.json({ codes });

  } catch (error) {
    console.error('Error obteniendo códigos:', error);
    res.status(500).json({ error: 'Error al obtener códigos' });
  }
});


app.get('/api/users/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const userResponse = user.toJSON();
    delete userResponse.password;

    res.json({ user: userResponse });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener usuario', details: error.message });
  }
});

app.get('/api/stores', async (req, res) => {
  try {
    const { category, lat, lng, maxDistance } = req.query;
    const where = category ? { category } : {};
    const stores = await Store.findAll({ where });
    
    // Si el cliente envió ubicación, filtrar por distancia
    if (lat && lng) {
      const clientLat = parseFloat(lat);
      const clientLng = parseFloat(lng);
      const maxDist = parseFloat(maxDistance) || 8; // 8km por defecto
      
      const nearbyStores = stores.filter(store => {
        if (!store.location?.lat || !store.location?.lng) {
          return false; // Tienda sin ubicación
        }
        
        const distance = calculateDistance(
          clientLat, 
          clientLng,
          store.location.lat,
          store.location.lng
        );
        
        // Agregar distancia al objeto store
        store.dataValues.distance = parseFloat(distance.toFixed(2));
        
        return distance <= maxDist;
      });
      
      // Ordenar por distancia (más cercanas primero)
      nearbyStores.sort((a, b) => a.dataValues.distance - b.dataValues.distance);
      
      console.log(`📍 Filtrado geográfico: ${nearbyStores.length}/${stores.length} tiendas dentro de ${maxDist}km`);
      
      return res.json({ 
        stores: nearbyStores,
        filtered: true,
        clientLocation: { lat: clientLat, lng: clientLng },
        maxDistance: maxDist,
        totalStores: stores.length
      });
    }
    
    // Si no hay ubicación, devolver todas
    res.json({ stores, filtered: false });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener tiendas', details: error.message });
  }
});

app.get('/api/stores/:storeId', async (req, res) => {
  try {
    const { storeId } = req.params;
    const store = await Store.findByPk(storeId);

    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    const products = await Product.findAll({ where: { storeId } });

    res.json({ store, products });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener tienda', details: error.message });
  }
});

app.post('/api/stores', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    if (req.user.role !== 'store_owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { name, description, category, deliveryTime, deliveryFee, minOrder, address, lat, lng } = req.body;

    let imageUrl = null;
    if (req.file) {
      imageUrl = await uploadImage(req.file.buffer, 'stores', `store-${Date.now()}`);
    }

    const newStore = await Store.create({
      name,
      description,
      category,
      image: imageUrl,
      deliveryTime,
      deliveryFee: parseFloat(deliveryFee),
      minOrder: parseFloat(minOrder),
      ownerId: req.user.id,
      location: { lat: parseFloat(lat), lng: parseFloat(lng), address }
    });

    res.status(201).json({ 
      message: 'Tienda creada exitosamente',
      store: newStore 
    });
  } catch (error) {
    console.error('Error al crear tienda:', error);
    res.status(500).json({ error: 'Error al crear tienda', details: error.message });
  }
});

app.put('/api/stores/:storeId', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    const { storeId } = req.params;
    const store = await Store.findByPk(storeId);

    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    if (store.ownerId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { name, description, category, deliveryTime, deliveryFee, minOrder, isOpen, address, lat, lng } = req.body;

    const updates = {};
    if (name) updates.name = name;
    if (description) updates.description = description;
    if (category) updates.category = category;
    if (deliveryTime) updates.deliveryTime = deliveryTime;
    if (deliveryFee) updates.deliveryFee = parseFloat(deliveryFee);
    if (minOrder) updates.minOrder = parseFloat(minOrder);
    if (typeof isOpen !== 'undefined') updates.isOpen = isOpen === 'true' || isOpen === true;
    
    if (req.file) {
      if (store.image) {
        await deleteImage(store.image);
      }
      updates.image = await uploadImage(req.file.buffer, 'stores', `store-${storeId}-${Date.now()}`);
    }
    
    if (address || lat || lng) {
      updates.location = {
        lat: lat ? parseFloat(lat) : store.location.lat,
        lng: lng ? parseFloat(lng) : store.location.lng,
        address: address || store.location.address
      };
    }

    await store.update(updates);

    res.json({ 
      message: 'Tienda actualizada exitosamente',
      store 
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar tienda', details: error.message });
  }
});

app.delete('/api/stores/:storeId', authenticateToken, async (req, res) => {
  try {
    const { storeId } = req.params;
    const store = await Store.findByPk(storeId);

    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    if (store.ownerId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    if (store.image) {
      await deleteImage(store.image);
    }

    const products = await Product.findAll({ where: { storeId } });
    for (const product of products) {
      if (product.image) {
        await deleteImage(product.image);
      }
    }

    await Product.destroy({ where: { storeId } });
    await store.destroy();

    res.json({ message: 'Tienda eliminada exitosamente' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar tienda', details: error.message });
  }
});

app.get('/api/stores/:storeId/products', async (req, res) => {
  try {
    const { storeId } = req.params;
    const { category } = req.query;
    
    const where = { storeId: parseInt(storeId) };
    if (category) where.category = category;

    const products = await Product.findAll({ where });

    res.json({ products });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener productos', details: error.message });
  }
});

app.post('/api/products', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    if (req.user.role !== 'store_owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { storeId, name, description, price, category, preparationTime } = req.body;
    
    const store = await Store.findByPk(storeId);
    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    if (store.ownerId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado para esta tienda' });
    }

    let imageUrl = null;
    if (req.file) {
      imageUrl = await uploadImage(req.file.buffer, 'products', `product-${Date.now()}`);
    }

    const newProduct = await Product.create({
      storeId: parseInt(storeId),
      name,
      description,
      price: parseFloat(price),
      image: imageUrl,
      category,
      preparationTime: parseInt(preparationTime) || 15
    });

    res.status(201).json({ 
      message: 'Producto creado exitosamente',
      product: newProduct 
    });
  } catch (error) {
    console.error('Error al crear producto:', error);
    res.status(500).json({ error: 'Error al crear producto', details: error.message });
  }
});

app.put('/api/products/:productId', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    const { productId } = req.params;
    const product = await Product.findByPk(productId);

    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    const store = await Store.findByPk(product.storeId);
    if (store.ownerId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { name, description, price, category, available, preparationTime } = req.body;

    const updates = {};
    if (name) updates.name = name;
    if (description) updates.description = description;
    if (price) updates.price = parseFloat(price);
    if (category) updates.category = category;
    if (typeof available !== 'undefined') updates.available = available === 'true' || available === true;
    if (preparationTime) updates.preparationTime = parseInt(preparationTime);
    
    if (req.file) {
      if (product.image) {
        await deleteImage(product.image);
      }
      updates.image = await uploadImage(req.file.buffer, 'products', `product-${productId}-${Date.now()}`);
    }

    await product.update(updates);

    res.json({ 
      message: 'Producto actualizado exitosamente',
      product 
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar producto', details: error.message });
  }
});

app.delete('/api/products/:productId', authenticateToken, async (req, res) => {
  try {
    const { productId } = req.params;
    const product = await Product.findByPk(productId);

    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    const store = await Store.findByPk(product.storeId);
    if (store.ownerId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    if (product.image) {
      await deleteImage(product.image);
    }

    await product.destroy();
    res.json({ message: 'Producto eliminado exitosamente' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar producto', details: error.message });
  }
});

app.post('/api/orders', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ error: 'Solo clientes pueden crear pedidos' });
    }

    const { storeId, items, deliveryAddress, paymentMethod, notes } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'El pedido debe tener al menos un producto' });
    }

    const store = await Store.findByPk(storeId);
    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    if (!store.isOpen) {
      return res.status(400).json({ error: 'La tienda está cerrada' });
    }

    let subtotal = 0;
    const orderItems = [];

    for (const item of items) {
      const product = await Product.findByPk(item.productId);
      if (!product) {
        throw new Error(`Producto ${item.productId} no encontrado`);
      }
      if (!product.available) {
        throw new Error(`Producto ${product.name} no disponible`);
      }
      const itemTotal = product.price * item.quantity;
      subtotal += itemTotal;
      orderItems.push({
        productId: product.id,
        name: product.name,
        price: product.price,
        quantity: item.quantity,
        total: itemTotal
      });
    }

    if (subtotal < store.minOrder) {
      return res.status(400).json({ 
        error: `El pedido mínimo es de $${store.minOrder}`,
        minOrder: store.minOrder,
        currentTotal: subtotal
      });
    }

    // Validar ubicación de tienda
    if (!store.location?.lat || !store.location?.lng) {
      return res.status(400).json({ 
        error: 'La tienda no tiene ubicación configurada.'
      });
    }
    
    // Validar ubicación de cliente
    if (!deliveryAddress?.lat || !deliveryAddress?.lng) {
      return res.status(400).json({ 
        error: 'Se requiere tu ubicación GPS para calcular la tarifa de entrega.'
      });
    }
    
    // Calcular distancia real
    const distance = calculateDistance(
      store.location.lat,
      store.location.lng,
      deliveryAddress.lat,
      deliveryAddress.lng
    );
    
    // Calcular tarifa
    const deliveryInfo = calculateDeliveryFee(distance);
    
    // Verificar radio máximo 8km
    if (!deliveryInfo) {
      return res.status(400).json({ 
        error: `Esta tienda solo entrega dentro de 8 km. Tu dirección está a ${distance.toFixed(1)} km.`,
        distance: distance.toFixed(2),
        maxDistance: 8
      });
    }
    
    const deliveryFee = deliveryInfo.deliveryFee;
    const total = subtotal + deliveryFee + SERVICE_FEE;
    const commission = subtotal * COMMISSION_RATE;
    const estimatedTime = estimateDeliveryTime(distance);

    const lastOrder = await Order.findOne({ order: [['orderNumber', 'DESC']] });
    const orderNumber = lastOrder ? lastOrder.orderNumber + 1 : 1;

    const customer = await User.findByPk(req.user.id);

    const newOrder = await Order.create({
      orderNumber,
      customerId: req.user.id,
      storeId,
      items: orderItems,
      subtotal,
      deliveryFee,
      serviceFee: SERVICE_FEE,
      commission,
      total,
      status: ORDER_STATES.PENDING,
      deliveryAddress,
      paymentMethod,
      notes: notes || '',
      distance: deliveryInfo.distance,
      statusHistory: [
        {
          status: ORDER_STATES.PENDING,
          timestamp: new Date(),
          note: 'Pedido creado'
        }
      ]
    });

    notifyUser(store.ownerId, {
      title: '¡Nuevo pedido!',
      message: `Pedido #${newOrder.orderNumber} - $${total.toFixed(2)}`,
      type: 'success',
      orderId: newOrder.id,
      timestamp: new Date()
    });

    notifyRole('admin', {
      title: 'Nuevo pedido en plataforma',
      message: `Pedido #${newOrder.orderNumber} en ${store.name}`,
      type: 'info',
      orderId: newOrder.id,
      timestamp: new Date()
    });

    res.status(201).json({ 
      message: 'Pedido creado exitosamente',
      order: newOrder,
      deliveryInfo: {
        distance: `${deliveryInfo.distance} km`,
        deliveryFee: `$${deliveryFee}`,
        estimatedTime: `${estimatedTime} minutos`
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al crear pedido', details: error.message });
  }
});

app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    const { status, lat, lng, maxDistance } = req.query;
    let where = {};

    if (req.user.role === 'client') {
      where.customerId = req.user.id;
    } else if (req.user.role === 'driver') {
      where = {
        [sequelize.Sequelize.Op.or]: [
          { driverId: req.user.id },
          { status: ORDER_STATES.READY }
        ]
      };
    } else if (req.user.role === 'store_owner') {
      const userStores = await Store.findAll({ where: { ownerId: req.user.id } });
      const storeIds = userStores.map(s => s.id);
      where.storeId = { [sequelize.Sequelize.Op.in]: storeIds };
    }

    if (status) {
      where.status = status;
    }

    let orders = await Order.findAll({
      where,
      include: [
        { model: User, as: 'customer', attributes: ['id', 'name', 'phone', 'email'] },
        { model: User, as: 'driver', attributes: ['id', 'name', 'phone'] },
        { model: Store, as: 'store', attributes: ['id', 'name', 'location'] }
      ],
      order: [['createdAt', 'DESC']]
    });

    // Si es conductor con ubicación, filtrar pedidos READY por distancia
    if (req.user.role === 'driver' && lat && lng) {
      const driverLat = parseFloat(lat);
      const driverLng = parseFloat(lng);
      const maxDist = parseFloat(maxDistance) || 8; // 8km por defecto
      
      const totalOrders = orders.length;
      
      orders = orders.filter(order => {
        // No filtrar pedidos ya asignados a este conductor
        if (order.driverId === req.user.id) {
          return true;
        }
        
        // Filtrar pedidos READY por distancia
        if (order.status === ORDER_STATES.READY) {
          const store = order.store;
          if (!store?.location?.lat || !store?.location?.lng) {
            console.warn(`⚠️ Pedido #${order.orderNumber} sin ubicación de tienda`);
            return false; // Tienda sin ubicación
          }
          
          const distance = calculateDistance(
            driverLat,
            driverLng,
            store.location.lat,
            store.location.lng
          );
          
          // Agregar distancia al pedido
          order.dataValues.distanceToStore = parseFloat(distance.toFixed(2));
          
          return distance <= maxDist;
        }
        
        return true;
      });
      
      // Ordenar pedidos READY por distancia (más cercanos primero)
      orders.sort((a, b) => {
        if (a.status === ORDER_STATES.READY && b.status === ORDER_STATES.READY) {
          return (a.dataValues.distanceToStore || 999) - (b.dataValues.distanceToStore || 999);
        }
        return 0;
      });
      
      const readyCount = orders.filter(o => o.status === ORDER_STATES.READY).length;
      console.log(`📍 Conductor: ${readyCount} pedidos disponibles dentro de ${maxDist}km`);
    }

    res.json({ orders });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener pedidos', details: error.message });
  }
});

app.get('/api/orders/:orderId', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await Order.findByPk(orderId, {
      include: [
        { model: User, as: 'customer', attributes: ['id', 'name', 'phone', 'email', 'address'] },
        { model: User, as: 'driver', attributes: ['id', 'name', 'phone', 'vehicle', 'currentLocation'] },
        { model: Store, as: 'store', attributes: ['id', 'name', 'location', 'phone'] }
      ]
    });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const userStore = await Store.findOne({ 
      where: { 
        ownerId: req.user.id,
        id: order.storeId 
      }
    });

    if (
      req.user.role !== 'admin' &&
      order.customerId !== req.user.id &&
      order.driverId !== req.user.id &&
      !userStore
    ) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    res.json({ order });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener pedido', details: error.message });
  }
});

app.put('/api/orders/:orderId/status', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status, note } = req.body;

    const order = await Order.findByPk(orderId, {
      include: [
        { model: User, as: 'customer' },
        { model: User, as: 'driver' },
        { model: Store, as: 'store' }
      ]
    });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const currentStateConfig = STATE_PERMISSIONS[order.status];
    if (!currentStateConfig) {
      return res.status(400).json({ error: 'Estado actual inválido' });
    }

    if (!currentStateConfig.nextStates.includes(status)) {
      return res.status(400).json({ 
        error: `No se puede cambiar de ${order.status} a ${status}`,
        allowedStates: currentStateConfig.nextStates
      });
    }

    if (!currentStateConfig.canUpdate.includes(req.user.role)) {
      return res.status(403).json({ 
        error: `El rol ${req.user.role} no puede actualizar desde ${order.status}`
      });
    }

    const userStore = await Store.findOne({ 
      where: { 
        ownerId: req.user.id,
        id: order.storeId 
      }
    });

    if (
      req.user.role === 'store_owner' && !userStore ||
      req.user.role === 'driver' && order.driverId !== req.user.id ||
      req.user.role === 'client' && order.customerId !== req.user.id
    ) {
      return res.status(403).json({ error: 'No autorizado para actualizar este pedido' });
    }

    const updates = { status };
    const statusHistory = [...order.statusHistory, {
      status,
      timestamp: new Date(),
      note: note || `Actualizado a ${status}`,
      updatedBy: req.user.id
    }];
    updates.statusHistory = statusHistory;

    if (status === ORDER_STATES.ACCEPTED) {
      updates.acceptedAt = new Date();
    } else if (status === ORDER_STATES.READY) {
      updates.readyAt = new Date();
    } else if (status === ORDER_STATES.PICKED_UP) {
      updates.pickedUpAt = new Date();
    } else if (status === ORDER_STATES.DELIVERED) {
      updates.deliveredAt = new Date();
      
      if (order.driverId) {
        const driver = await User.findByPk(order.driverId);
        const driverEarnings = order.deliveryFee * 0.8;
        const platformEarnings = order.commission + (order.deliveryFee * 0.2);
        
        await driver.update({
          totalDeliveries: driver.totalDeliveries + 1,
          totalEarnings: driver.totalEarnings + driverEarnings
        });

        updates.driverEarnings = driverEarnings;
        updates.platformEarnings = platformEarnings;

        notifyUser(order.driverId, {
          title: 'Pedido completado',
          message: `Has ganado $${driverEarnings.toFixed(2)} por el pedido #${order.orderNumber}`,
          type: 'success',
          timestamp: new Date()
        });
      }

      notifyUser(order.customerId, {
        title: 'Pedido entregado',
        message: `Tu pedido #${order.orderNumber} ha sido entregado`,
        type: 'success',
        timestamp: new Date()
      });

      notifyUser(order.store.ownerId, {
        title: 'Pedido completado',
        message: `Pedido #${order.orderNumber} entregado exitosamente`,
        type: 'success',
        timestamp: new Date()
      });
    }

    await order.update(updates);

    let notificationMessage = '';
    if (status === ORDER_STATES.ACCEPTED) {
      notificationMessage = `Tu pedido #${order.orderNumber} ha sido aceptado`;
      notifyUser(order.customerId, {
        title: 'Pedido aceptado',
        message: notificationMessage,
        type: 'success',
        orderId: order.id,
        timestamp: new Date()
      });
    } else if (status === ORDER_STATES.READY) {
      notificationMessage = `Pedido #${order.orderNumber} listo para recoger en ${order.store.name}`;
      notifyRole('driver', {
        title: 'Nuevo pedido disponible',
        message: notificationMessage,
        type: 'info',
        orderId: order.id,
        timestamp: new Date()
      });
    }

    res.json({ 
      message: 'Estado actualizado exitosamente',
      order 
    });
  } catch (error) {
    console.error('Error actualizando estado:', error);
    res.status(500).json({ error: 'Error al actualizar estado', details: error.message });
  }
});

app.put('/api/orders/:orderId/assign', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Solo conductores pueden asignarse pedidos' });
    }

    const { orderId } = req.params;
    const order = await Order.findByPk(orderId, {
      include: [
        { model: Store, as: 'store' },
        { model: User, as: 'customer' }
      ]
    });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    if (order.status !== ORDER_STATES.READY) {
      return res.status(400).json({ 
        error: 'Solo se pueden asignar pedidos en estado "ready"' 
      });
    }

    if (order.driverId) {
      return res.status(400).json({ error: 'Este pedido ya tiene un conductor asignado' });
    }

    const driver = await User.findByPk(req.user.id);
    if (!driver.available) {
      return res.status(400).json({ error: 'Debes estar disponible para tomar pedidos' });
    }

    await order.update({
      driverId: req.user.id,
      assignedAt: new Date(),
      statusHistory: [...order.statusHistory, {
        status: 'assigned_to_driver',
        timestamp: new Date(),
        note: `Asignado al conductor ${driver.name}`,
        driverId: driver.id
      }]
    });

    notifyUser(order.customerId, {
      title: 'Conductor asignado',
      message: `${driver.name} recogerá tu pedido`,
      type: 'info',
      orderId: order.id,
      timestamp: new Date()
    });

    notifyUser(order.store.ownerId, {
      title: 'Conductor asignado',
      message: `${driver.name} recogerá el pedido #${order.orderNumber}`,
      type: 'info',
      orderId: order.id,
      timestamp: new Date()
    });

    res.json({ 
      message: 'Pedido asignado exitosamente',
      order 
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al asignar pedido', details: error.message });
  }
});

app.get('/api/drivers', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const drivers = await User.findAll({
      where: { role: 'driver' },
      attributes: { exclude: ['password'] }
    });

    res.json({ drivers });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener conductores', details: error.message });
  }
});

// Ruta para obtener todos los clientes (para admin)
app.get('/api/clients', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const clients = await User.findAll({
      where: { role: 'client' },
      attributes: { exclude: ['password'] },
      order: [['createdAt', 'DESC']]
    });

    res.json({ clients });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener clientes', details: error.message });
  }
});

// Ruta para obtener todas las tiendas (para admin)
app.get('/api/admin/stores', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const stores = await Store.findAll({
      include: [{
        model: User,
        as: 'owner',
        attributes: ['id', 'name', 'email', 'phone']
      }],
      order: [['createdAt', 'DESC']]
    });

    res.json({ stores });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener tiendas', details: error.message });
  }
});

// Ruta para limpiar imágenes no usadas de Cloudinary
app.post('/api/admin/clean-images', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // Por ahora retornamos éxito
    // En el futuro se puede implementar limpieza real de Cloudinary
    res.json({ 
      message: 'Limpieza de imágenes completada',
      deleted: 0,
      note: 'Funcionalidad de limpieza automática pendiente de implementación'
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al limpiar imágenes', details: error.message });
  }
});


app.get('/api/drivers/available', async (req, res) => {
  try {
    const drivers = await User.findAll({
      where: { 
        role: 'driver',
        available: true,
        approved: true
      },
      attributes: ['id', 'name', 'currentLocation', 'rating']
    });

    res.json({ drivers });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener conductores', details: error.message });
  }
});

app.put('/api/drivers/availability', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Solo conductores pueden cambiar disponibilidad' });
    }

    const { available } = req.body;
    const driver = await User.findByPk(req.user.id);

    if (!driver.approved) {
      return res.status(403).json({ error: 'Tu cuenta debe ser aprobada primero' });
    }

    await driver.update({ available });

    res.json({ 
      message: `Disponibilidad actualizada a ${available ? 'disponible' : 'no disponible'}`,
      available: driver.available
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar disponibilidad', details: error.message });
  }
});

app.put('/api/drivers/:driverId/approve', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { driverId } = req.params;
    const driver = await User.findByPk(driverId);

    if (!driver) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    if (driver.role !== 'driver') {
      return res.status(400).json({ error: 'El usuario no es un conductor' });
    }

    await driver.update({ approved: true });

    notifyUser(driver.id, {
      title: 'Cuenta aprobada',
      message: 'Tu cuenta de conductor ha sido aprobada. Ya puedes comenzar a trabajar.',
      type: 'success',
      timestamp: new Date()
    });

    res.json({ 
      message: 'Conductor aprobado exitosamente',
      driver
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al aprobar conductor', details: error.message });
  }
});

app.delete('/api/drivers/:driverId', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { driverId } = req.params;
    const driver = await User.findByPk(driverId);

    if (!driver) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    notifyUser(driver.id, {
      title: 'Solicitud rechazada',
      message: 'Tu solicitud de conductor no ha sido aprobada.',
      type: 'warning',
      timestamp: new Date()
    });

    await driver.destroy();

    res.json({ message: 'Conductor rechazado' });
  } catch (error) {
    res.status(500).json({ error: 'Error al rechazar conductor', details: error.message });
  }
});

app.get('/api/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    let stats = {};

    if (userRole === 'client') {
      const userOrders = await Order.findAll({ where: { customerId: userId } });
      stats = {
        totalOrders: userOrders.length,
        totalSpent: userOrders.reduce((sum, o) => sum + o.total, 0),
        completedOrders: userOrders.filter(o => o.status === 'delivered').length,
        cancelledOrders: userOrders.filter(o => o.status === 'cancelled').length
      };
    } else if (userRole === 'driver') {
      const driver = await User.findByPk(userId);
      const driverOrders = await Order.findAll({ where: { driverId: userId } });
      const completedOrders = driverOrders.filter(o => o.status === 'delivered');
      const today = new Date().toDateString();
      
      stats = {
        totalDeliveries: driver.totalDeliveries,
        totalEarnings: driver.totalEarnings,
        rating: driver.rating,
        activeOrders: driverOrders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length,
        completedToday: completedOrders.filter(o => {
          return o.deliveredAt && new Date(o.deliveredAt).toDateString() === today;
        }).length,
        earningsToday: completedOrders
          .filter(o => {
            return o.deliveredAt && new Date(o.deliveredAt).toDateString() === today;
          })
          .reduce((sum, o) => sum + (o.driverEarnings || 0), 0)
      };
    } else if (userRole === 'store_owner') {
      const userStores = await Store.findAll({ where: { ownerId: userId } });
      const storeIds = userStores.map(s => s.id);
      const storeOrders = await Order.findAll({ 
        where: { 
          storeId: { [sequelize.Sequelize.Op.in]: storeIds } 
        } 
      });
      const completedOrders = storeOrders.filter(o => o.status === 'delivered');
      const today = new Date().toDateString();
      
      stats = {
        totalStores: userStores.length,
        totalProducts: await Product.count({ 
          where: { storeId: { [sequelize.Sequelize.Op.in]: storeIds } }
        }),
        totalOrders: storeOrders.length,
        totalRevenue: completedOrders.reduce((sum, o) => sum + o.subtotal, 0),
        activeOrders: storeOrders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length,
        ordersToday: storeOrders.filter(o => {
          return new Date(o.createdAt).toDateString() === today;
        }).length
      };
    } else if (userRole === 'admin') {
      // Stats para administradores
      const allStores = await Store.findAll();
      const allOrders = await Order.findAll();
      const completedOrders = allOrders.filter(o => o.status === 'delivered');
      const today = new Date().toDateString();
      
      stats = {
        totalStores: allStores.length,
        totalProducts: await Product.count(),
        totalOrders: allOrders.length,
        activeOrders: allOrders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length,
        completedOrders: completedOrders.length,
        totalRevenue: completedOrders.reduce((sum, o) => sum + (o.total || 0), 0),
        platformEarnings: completedOrders.reduce((sum, o) => sum + (o.platformEarnings || 0), 0),
        ordersToday: allOrders.filter(o => {
          return new Date(o.createdAt).toDateString() === today;
        }).length,
        revenueToday: allOrders
          .filter(o => {
            return o.deliveredAt && new Date(o.deliveredAt).toDateString() === today;
          })
          .reduce((sum, o) => sum + (o.total || 0), 0)
      };
    }

    res.json({ stats });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estadísticas', details: error.message });
  }
});


// ============================================
// RUTAS DE GESTIÓN DE CONDUCTORES (ADMIN)
// Agregar después de las rutas de autenticación
// ============================================

// GET /api/admin/drivers/commissions - Obtener comisiones de todos los conductores
app.get('/api/admin/drivers/commissions', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo administradores' });
    }

    // Obtener todos los conductores
    const allDrivers = await User.findAll({
      where: { role: 'driver' },
      order: [['createdAt', 'DESC']]
    });

    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay()); // Domingo
    startOfWeek.setHours(0, 0, 0, 0);

    const drivers = await Promise.all(allDrivers.map(async (driver) => {
      // Pedidos completados de la semana
      const weekOrders = await Order.findAll({
        where: {
          driverId: driver.id,
          status: 'delivered',
          deliveredAt: {
            [sequelize.Sequelize.Op.gte]: startOfWeek
          }
        }
      });

      // Calcular comisiones de la semana (20% del delivery fee)
      const weekCommissions = weekOrders.reduce((sum, order) => {
        return sum + (order.deliveryFee * 0.2);
      }, 0);

      // Calcular comisiones históricas totales
      const allOrders = await Order.findAll({
        where: {
          driverId: driver.id,
          status: 'delivered'
        }
      });

      const totalCommissions = allOrders.reduce((sum, order) => {
        return sum + (order.deliveryFee * 0.2);
      }, 0);

      // Último pago (simulado - en producción buscar en tabla de pagos)
      const lastPaymentDate = driver.lastPaymentDate || null;
      const daysSincePayment = lastPaymentDate 
        ? Math.floor((now - new Date(lastPaymentDate)) / (1000 * 60 * 60 * 24))
        : 999;

      // Determinar estado
      let status;
      
      // Verificar si pagó esta semana
      const paidThisWeek = lastPaymentDate && new Date(lastPaymentDate) >= startOfWeek;
      
      if (!driver.approved) {
        status = 'pending';
      } else if (driver.suspended) {
        status = 'suspended';
      } else if (paidThisWeek && weekCommissions > 0) {
        // Si pagó esta semana, considerar que está al corriente aunque tenga comisión acumulada
        status = 'clear';
      } else if (daysSincePayment > 7 && weekCommissions > 0) {
        status = 'overdue';
      } else if (weekCommissions > 0) {
        status = 'active_debt';
      } else {
        status = 'clear';
      }

      return {
        id: driver.id,
        name: driver.name,
        email: driver.email,
        phone: driver.phone,
        balance: driver.balance || 0,
        totalDeliveries: driver.totalDeliveries || 0,
        weekCommissions: Math.round(weekCommissions * 100) / 100,
        totalCommissions: Math.round(totalCommissions * 100) / 100,
        lastPayment: lastPaymentDate,
        daysSincePayment,
        suspended: driver.suspended || false,
        approved: driver.approved || false,
        status
      };
    }));

    // Calcular resumen
    const summary = {
      totalDrivers: drivers.length,
      activeDrivers: drivers.filter(d => d.approved && !d.suspended).length,
      driversWithDebt: drivers.filter(d => d.weekCommissions > 0).length,
      overdueDrivers: drivers.filter(d => d.status === 'overdue').length,
      suspendedDrivers: drivers.filter(d => d.suspended).length,
      totalPendingCommissions: drivers.reduce((sum, d) => sum + d.weekCommissions, 0)
    };

    res.json({ drivers, summary });

  } catch (error) {
    console.error('Error obteniendo comisiones:', error);
    res.status(500).json({ error: 'Error al obtener comisiones' });
  }
});

// POST /api/admin/drivers/:driverId/register-payment - Registrar pago de comisión
app.post('/api/admin/drivers/:driverId/register-payment', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo administradores' });
    }

    const { driverId } = req.params;
    const { amount, note } = req.body;

    const driver = await User.findByPk(driverId);
    if (!driver) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    // Actualizar balance y fecha de último pago
    await driver.update({
      balance: (driver.balance || 0) - amount,
      lastPaymentDate: new Date()
    });

    // TODO: Guardar en tabla de historial de pagos
    console.log(`💰 Pago registrado: ${driver.name} pagó $${amount}`);

    res.json({
      message: 'Pago registrado exitosamente',
      driver: {
        id: driver.id,
        name: driver.name,
        newBalance: driver.balance
      }
    });

  } catch (error) {
    console.error('Error registrando pago:', error);
    res.status(500).json({ error: 'Error al registrar pago' });
  }
});

// POST /api/admin/drivers/:driverId/suspend - Suspender conductor
app.post('/api/admin/drivers/:driverId/suspend', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo administradores' });
    }

    const { driverId } = req.params;
    const { reason } = req.body;

    const driver = await User.findByPk(driverId);
    if (!driver) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    await driver.update({
      suspended: true,
      suspendedAt: new Date(),
      suspensionReason: reason || 'Sin razón especificada'
    });

    // Notificar al conductor
    notifyUser(driver.id, {
      title: '🚫 Cuenta Suspendida',
      message: `Tu cuenta ha sido suspendida. Razón: ${reason || 'Contacta al administrador'}`,
      type: 'error'
    });

    console.log(`🚫 Conductor suspendido: ${driver.name} - Razón: ${reason}`);

    res.json({
      message: 'Conductor suspendido exitosamente',
      driver: {
        id: driver.id,
        name: driver.name,
        suspended: true
      }
    });

  } catch (error) {
    console.error('Error suspendiendo conductor:', error);
    res.status(500).json({ error: 'Error al suspender conductor' });
  }
});

// POST /api/admin/drivers/:driverId/activate - Activar/reactivar conductor
app.post('/api/admin/drivers/:driverId/activate', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo administradores' });
    }

    const { driverId } = req.params;

    const driver = await User.findByPk(driverId);
    if (!driver) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    await driver.update({
      suspended: false,
      suspendedAt: null,
      suspensionReason: null
    });

    // Notificar al conductor
    notifyUser(driver.id, {
      title: '✅ Cuenta Reactivada',
      message: 'Tu cuenta ha sido reactivada. Ya puedes trabajar nuevamente.',
      type: 'success'
    });

    console.log(`✅ Conductor reactivado: ${driver.name}`);

    res.json({
      message: 'Conductor reactivado exitosamente',
      driver: {
        id: driver.id,
        name: driver.name,
        suspended: false
      }
    });

  } catch (error) {
    console.error('Error reactivando conductor:', error);
    res.status(500).json({ error: 'Error al reactivar conductor' });
  }
});

// GET /api/admin/drivers/:driverId/orders - Ver pedidos de un conductor
app.get('/api/admin/drivers/:driverId/orders', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo administradores' });
    }

    const { driverId } = req.params;
    const driver = await User.findByPk(driverId);
    
    if (!driver) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    const orders = await Order.findAll({
      where: { driverId },
      include: [
        { model: User, as: 'customer' },
        { model: Store, as: 'store' }
      ],
      order: [['createdAt', 'DESC']],
      limit: 50
    });

    res.json({
      driver: {
        id: driver.id,
        name: driver.name
      },
      orders: orders.map(o => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        total: o.total,
        deliveryFee: o.deliveryFee,
        commission: o.deliveryFee * 0.2,
        customer: o.customer?.name,
        store: o.store?.name,
        createdAt: o.createdAt,
        deliveredAt: o.deliveredAt
      }))
    });

  } catch (error) {
    console.error('Error obteniendo pedidos:', error);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});


io.on('connection', (socket) => {
  console.log('🔌 Cliente conectado:', socket.id);

  socket.on('register', (data) => {
    const { userId } = data;
    userSockets.set(userId.toString(), socket.id);
    console.log(`✅ Usuario ${userId} registrado con socket ${socket.id}`);
  });

  socket.on('subscribe', (data) => {
    const { userId, role } = data;
    socket.join(`${role}:${userId}`);
    userSockets.set(userId.toString(), socket.id);
    console.log(`📡 Usuario ${userId} (${role}) suscrito`);
  });

  socket.on('update_location', async (data) => {
    const { driverId, lat, lng } = data;
    try {
      const driver = await User.findByPk(driverId);
      if (driver) {
        await driver.update({ currentLocation: { lat, lng } });
        io.emit('driver_location_update', { driverId, location: { lat, lng } });
      }
    } catch (error) {
      console.error('Error actualizando ubicación:', error);
    }
  });

  socket.on('disconnect', () => {
    for (const [userId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(userId);
        console.log(`❌ Usuario ${userId} desconectado`);
        break;
      }
    }
    console.log('🔌 Cliente desconectado:', socket.id);
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/cliente', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cliente.html'));
});

app.get('/conductor', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'conductor.html'));
});

app.get('/tienda', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tienda.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
// ============================================
// ENDPOINT DE LIMPIEZA DE IMÁGENES ANTIGUAS
// ============================================
app.post('/api/admin/clean-images', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo administradores pueden ejecutar esta acción' });
    }

    console.log('🧹 Iniciando limpieza de imágenes antiguas...');

    // Limpiar tiendas con rutas locales
    const storesUpdated = await Store.update(
      { image: null },
      {
        where: {
          image: {
            [sequelize.Sequelize.Op.like]: '/uploads/%'
          }
        }
      }
    );

    // Limpiar productos con rutas locales
    const productsUpdated = await Product.update(
      { image: null },
      {
        where: {
          image: {
            [sequelize.Sequelize.Op.like]: '/uploads/%'
          }
        }
      }
    );

    const result = {
      success: true,
      message: 'Imágenes antiguas limpiadas exitosamente',
      storesUpdated: storesUpdated[0],
      productsUpdated: productsUpdated[0],
      timestamp: new Date()
    };

    console.log('✅ Limpieza completada:', result);

    res.json(result);
  } catch (error) {
    console.error('❌ Error en limpieza:', error);
    res.status(500).json({ 
      error: 'Error al limpiar imágenes', 
      details: error.message 
    });
  }
});
app.get('/health', async (req, res) => {
  try {
    const dbStatus = await testConnection();
    
    res.json({
      status: 'ok',
      timestamp: new Date(),
      uptime: process.uptime(),
      database: dbStatus ? 'connected' : 'disconnected',
      stores: await Store.count(),
      products: await Product.count(),
      orders: await Order.count(),
      connectedUsers: userSockets.size,
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(err.status || 500).json({ 
    error: 'Error del servidor',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Ocurrió un error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

async function startServer() {
  try {
    const dbConnected = await testConnection();
    
    if (!dbConnected) {
      console.error('❌ No se pudo conectar a PostgreSQL');
      console.error('💡 Verifica que DATABASE_URL esté configurado en .env');
      process.exit(1);
    }

    await sequelize.sync({ alter: false });
    console.log('✅ Modelos sincronizados con PostgreSQL');

    const userCount = await User.count();
    if (userCount === 0) {
      console.log('\n⚠️  La base de datos está vacía');
      console.log('💡 Ejecuta: node scripts/seed.js para poblar datos iniciales\n');
    }

    server.listen(PORT, () => {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🚀 SERVIDOR DE DELIVERY INICIADO`);
      console.log(`${'='.repeat(60)}`);
      console.log(`🌐 Puerto: ${PORT}`);
      console.log(`🔒 Modo: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🗄️  Base de datos: PostgreSQL ✅`);
      console.log(`📡 WebSocket: Habilitado`);
      console.log(`🔔 Notificaciones: Activas`);
      console.log(`☁️  Cloudinary: Configurado`);
      console.log(`🛡️  Seguridad: Helmet ✅ | Rate Limiting ✅ | Bcrypt ✅`);
      console.log(`💰 Comisión: ${COMMISSION_RATE * 100}% | Fee de servicio: ${SERVICE_FEE}`);
      console.log(`\n📋 FLUJO DE ESTADOS DE PEDIDOS:`);
      console.log(`   1. PENDING    → Cliente crea pedido`);
      console.log(`   2. ACCEPTED   → Tienda acepta`);
      console.log(`   3. PREPARING  → Tienda prepara`);
      console.log(`   4. READY      → Listo para recoger`);
      console.log(`   5. PICKED_UP  → Conductor recoge`);
      console.log(`   6. ON_WAY     → En camino al cliente`);
      console.log(`   7. DELIVERED  → ✅ Entregado`);
      console.log(`\n👥 USUARIOS DE PRUEBA:`);
      console.log(`   Cliente:    cliente@delivery.com / cliente123`);
      console.log(`   Conductor:  conductor@delivery.com / conductor123`);
      console.log(`   Tienda:     tienda@delivery.com / tienda123`);
      console.log(`   Admin:      admin@delivery.com / admin123`);
      console.log(`${'='.repeat(60)}\n`);
    });

  } catch (error) {
    console.error('❌ Error al iniciar servidor:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  console.log('👋 SIGTERM recibido, cerrando servidor...');
  await sequelize.close();
  server.close(() => {
    console.log('✅ Servidor cerrado');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('\n👋 SIGINT recibido, cerrando servidor...');
  await sequelize.close();
  server.close(() => {
    console.log('✅ Servidor cerrado');
    process.exit(0);
  });
});

startServer();

module.exports = { app, server, io };