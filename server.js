require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const multer = require('multer');
// ELIMINAMOS 'fs' y la lógica de manejo de carpetas locales
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// AÑADIMOS LIBRERÍAS DE CLOUDINARY
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const { User, Store, Product, Order, sequelize } = require('./models');
const { testConnection } = require('./config/database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
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

// ----------------------------------------------------
// --- NUEVA CONFIGURACIÓN DE MULTER CON CLOUDINARY ---
// ----------------------------------------------------

// 1. Configurar credenciales (usa el CLOUDINARY_URL que proporcionaste)
cloudinary.config({ 
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
  api_key: process.env.CLOUDINARY_API_KEY, 
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// 2. Función de ayuda para extraer el Public ID de una URL de Cloudinary
function extractPublicId(url) {
    if (!url) return null;
    // Ejemplo: https://res.cloudinary.com/dhs1nqbqq/image/upload/v123456789/delivery-app/products/product-name-12345.jpg
    const parts = url.split('/');
    // Busca la carpeta 'delivery-app' y toma todo lo que sigue (incluyendo la extensión para que 'destroy' lo pueda truncar)
    const publicIdWithExtension = parts.slice(parts.indexOf('delivery-app')).join('/');
    return publicIdWithExtension.split('.').slice(0, -1).join('.'); // Elimina la extensión
}


// 3. Definir el nuevo storage engine
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: (req, file) => {
    const folder = req.body.type === 'store' ? 'stores' : 'products';
    return {
      folder: `delivery-app/${folder}`,
      allowed_formats: ['jpeg', 'png', 'webp', 'jpg'],
      // Usamos el nombre del archivo y un timestamp como public_id
      public_id: file.originalname.split('.')[0] + '-' + Date.now(), 
      transformation: [{ width: 800, height: 800, crop: "limit" }] 
    };
  },
});

// 4. Configurar Multer con CloudinaryStorage
const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imágenes (JPG, PNG, WEBP)'), false);
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// ----------------------------------------------------
// --- FIN DE CONFIGURACIÓN CLOUDINARY ---
// ----------------------------------------------------

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
// ELIMINAMOS: app.use('/uploads', express.static('uploads'));

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

// --- RUTAS DE AUTENTICACIÓN (sin cambios) ---

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

    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    if (user.role === 'driver' && !user.approved) {
      return res.status(403).json({ 
        error: 'Tu cuenta de conductor está pendiente de aprobación' 
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

app.get('/api/auth/me', authenticateToken, async (req, res) => {
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

// --- RUTAS DE TIENDA (STORES) ---

app.get('/api/stores', async (req, res) => {
  try {
    const { category } = req.query;
    const where = category ? { category } : {};

    const stores = await Store.findAll({ where });

    res.json({ stores });
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

    const newStore = await Store.create({
      name,
      description,
      category,
      // CAMBIO CLOUDINARY: Guardar la URL completa devuelta por Cloudinary
      image: req.file ? req.file.path : null, 
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
    // Si la subida a Cloudinary falla (por ejemplo, por límite de tamaño), multer devuelve un error
    if (error instanceof multer.MulterError) {
        return res.status(400).json({ error: 'Error de subida de archivo: ' + error.message });
    }
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
    
    // CAMBIO CLOUDINARY: Si hay un nuevo archivo, se actualiza la URL
    if (req.file) updates.image = req.file.path;
    
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
     if (error instanceof multer.MulterError) {
        return res.status(400).json({ error: 'Error de subida de archivo: ' + error.message });
    }
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

    // CAMBIO CLOUDINARY: Borrar el archivo de imagen de la tienda en la nube
    if (store.image) {
        const publicId = extractPublicId(store.image);
        if (publicId) {
            await cloudinary.uploader.destroy(publicId);
        }
    }
    
    // Borrar archivos de todos los productos de la tienda antes de eliminar los registros
    const products = await Product.findAll({ where: { storeId } });
    for (const product of products) {
        if (product.image) {
            const publicId = extractPublicId(product.image);
            if (publicId) {
                await cloudinary.uploader.destroy(publicId);
            }
        }
    }

    await Product.destroy({ where: { storeId } });
    await store.destroy();

    res.json({ message: 'Tienda eliminada exitosamente' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar tienda', details: error.message });
  }
});

// --- RUTAS DE PRODUCTOS ---

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

    const newProduct = await Product.create({
      storeId: parseInt(storeId),
      name,
      description,
      price: parseFloat(price),
      // CAMBIO CLOUDINARY: Guardar la URL completa devuelta por Cloudinary
      image: req.file ? req.file.path : null, 
      category,
      preparationTime: parseInt(preparationTime) || 15
    });

    res.status(201).json({ 
      message: 'Producto creado exitosamente',
      product: newProduct 
    });
  } catch (error) {
     if (error instanceof multer.MulterError) {
        return res.status(400).json({ error: 'Error de subida de archivo: ' + error.message });
    }
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
    
    // CAMBIO CLOUDINARY: Si hay un nuevo archivo, se actualiza la URL
    if (req.file) updates.image = req.file.path;

    await product.update(updates);

    res.json({ 
      message: 'Producto actualizado exitosamente',
      product 
    });
  } catch (error) {
    if (error instanceof multer.MulterError) {
        return res.status(400).json({ error: 'Error de subida de archivo: ' + error.message });
    }
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

    // CAMBIO CLOUDINARY: Borrar el archivo de imagen físico de la nube
    if (product.image) {
        const publicId = extractPublicId(product.image);
        if (publicId) {
             await cloudinary.uploader.destroy(publicId);
        }
    }
    
    await product.destroy();
    res.json({ message: 'Producto eliminado exitosamente' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar producto', details: error.message });
  }
});

// --- RUTAS DE PEDIDOS Y DRIVERS (sin cambios) ---

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

    const deliveryFee = store.deliveryFee;
    const total = subtotal + deliveryFee + SERVICE_FEE;
    const commission = subtotal * COMMISSION_RATE;

    const lastOrder = await Order.findOne({ order: [['orderNumber', 'DESC']] });
    const orderNumber = lastOrder ? lastOrder.orderNumber + 1 : 1;

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
      distance: 5.2,
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
      order: newOrder 
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al crear pedido', details: error.message });
  }
});

app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    const { status } = req.query;
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

    const orders = await Order.findAll({
      where, 
      include: [
        { model: User, as: 'customer', attributes: ['id', 'name', 'phone'] },
        { model: User, as: 'driver', attributes: ['id', 'name', 'phone', 'vehicle'] },
        { model: Store, as: 'store', attributes: ['id', 'name', 'location'] }
      ],
      order: [['createdAt', 'DESC']]
    });

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
        { model: User, as: 'customer' },
        { model: User, as: 'driver' },
        { model: Store, as: 'store' }
      ]
    });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const hasAccess = req.user.role === 'admin' || order.customerId === req.user.id || order.driverId === req.user.id || (req.user.role === 'store_owner' && order.store.ownerId === req.user.id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'No tienes acceso a este pedido' });
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

    const order = await Order.findByPk(orderId, { include: [{ model: Store, as: 'store' }] });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const currentStatePermissions = STATE_PERMISSIONS[order.status];
    if (!currentStatePermissions.canUpdate.includes(req.user.role)) {
      return res.status(403).json({ error: `Solo ${currentStatePermissions.canUpdate.join(' o ')} pueden actualizar este estado` });
    }

    if (!currentStatePermissions.nextStates.includes(status)) {
      return res.status(400).json({ error: `No se puede cambiar de ${order.status} a ${status}`, allowedStates: currentStatePermissions.nextStates });
    }

    const updates = { status };
    const statusHistory = [...order.statusHistory, { status, timestamp: new Date(), note: note || '', updatedBy: req.user.id }];
    updates.statusHistory = statusHistory;

    if (status === ORDER_STATES.PICKED_UP) {
      updates.pickedUpAt = new Date();
      if (!order.driverId && req.user.role === 'driver') {
        const deliveryDistance = order.distance || 5;
        const driverEarnings = (order.deliveryFee * 0.7) + (deliveryDistance * 5);
        updates.driverId = req.user.id;
        updates.assignedAt = new Date();
        updates.driverEarnings = driverEarnings;
        console.log(`✅ Conductor ${req.user.id} auto-asignado al pedido ${order.id}`);
      }
    } else if (status === ORDER_STATES.DELIVERED) {
      updates.deliveredAt = new Date();
      updates.platformEarnings = order.commission + order.serviceFee;
      if (order.driverId) {
        const driver = await User.findByPk(order.driverId);
        await driver.update({ totalDeliveries: driver.totalDeliveries + 1, totalEarnings: driver.totalEarnings + order.driverEarnings });
      }
    } else if (status === ORDER_STATES.ACCEPTED) {
      updates.acceptedAt = new Date();
    } else if (status === ORDER_STATES.READY) {
      updates.readyAt = new Date();
    }

    await order.update(updates);

    notifyUser(order.customerId, {
      title: 'Actualización de pedido',
      message: getStatusMessage(status),
      type: 'info',
      orderId: order.id,
      status: status,
      timestamp: new Date()
    });

    if (status === ORDER_STATES.READY) {
      notifyRole('driver', {
        title: '¡Nuevo pedido disponible!',
        message: `Pedido #${order.orderNumber} listo para recoger en ${order.store.name}`,
        type: 'success',
        orderId: order.id,
        timestamp: new Date()
      });
    }

    res.json({ message: 'Estado actualizado exitosamente', order });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar estado', details: error.message });
  }
});

function getStatusMessage(status) {
  const messages = {
    'accepted': 'Tu pedido ha sido aceptado y está siendo preparado',
    'preparing': 'Tu pedido está en preparación',
    'ready': 'Tu pedido está listo y esperando al conductor',
    'picked_up': 'El conductor ha recogido tu pedido',
    'on_way': 'Tu pedido está en camino',
    'delivered': '¡Tu pedido ha sido entregado!',
    'cancelled': 'Tu pedido ha sido cancelado'
  };
  return messages[status] || 'Estado del pedido actualizado';
}

app.put('/api/orders/:orderId/assign', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Solo conductores pueden asignarse pedidos' });
    }

    const { orderId } = req.params;
    const order = await Order.findByPk(orderId, { include: [{ model: Store, as: 'store' }] });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    if (order.status !== ORDER_STATES.READY) {
      return res.status(400).json({ error: 'El pedido no está listo para ser recogido' });
    }

    if (order.driverId) {
      return res.status(400).json({ error: 'El pedido ya tiene un conductor asignado' });
    }

    const driver = await User.findByPk(req.user.id);
    if (!driver.approved || !driver.available) {
      return res.status(403).json({ error: 'No estás disponible para tomar pedidos' });
    }

    const deliveryDistance = 5;
    const driverEarnings = (order.deliveryFee * 0.7) + (deliveryDistance * 5);

    await order.update({ 
      driverId: req.user.id, 
      assignedAt: new Date(), 
      driverEarnings 
    });

    notifyUser(order.customerId, {
      title: 'Conductor asignado',
      message: `${driver.name} recogerá tu pedido`,
      type: 'info',
      orderId: order.id,
      timestamp: new Date()
    });

    res.json({ message: 'Pedido asignado exitosamente', order, earnings: driverEarnings });
  } catch (error) {
    res.status(500).json({ error: 'Error al asignar pedido', details: error.message });
  }
});

// --- RUTAS DE DRIVERS Y OTROS (sin cambios) ---

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

app.get('/api/drivers/available', async (req, res) => {
  try {
    const drivers = await User.findAll({ 
      where: { role: 'driver', available: true, approved: true }, 
      attributes: { exclude: ['password', 'email'] } 
    });

    const driversWithOrders = await Promise.all(drivers.map(async (driver) => {
      const activeOrders = await Order.count({ 
        where: { 
          driverId: driver.id, 
          status: { [sequelize.Sequelize.Op.notIn]: ['delivered', 'cancelled'] } 
        } 
      });
      return { ...driver.toJSON(), activeOrders };
    }));

    res.json({ drivers: driversWithOrders });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener conductores', details: error.message });
  }
});

app.put('/api/drivers/:driverId/availability', authenticateToken, async (req, res) => {
  try {
    const { driverId } = req.params;
    const { available } = req.body;

    if (req.user.id !== parseInt(driverId) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const driver = await User.findByPk(driverId);
    if (!driver || driver.role !== 'driver') {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    await driver.update({ available: available === 'true' || available === true });

    res.json({ message: 'Disponibilidad actualizada', driver });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar disponibilidad', details: error.message });
  }
});

app.put('/api/drivers/:driverId/approval', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { driverId } = req.params;
    const { approved } = req.body;

    const driver = await User.findByPk(driverId);
    if (!driver || driver.role !== 'driver') {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    await driver.update({ approved: approved === 'true' || approved === true });

    if (approved === 'true' || approved === true) {
      notifyUser(driver.id, {
        title: '¡Aprobación de cuenta!',
        message: 'Tu cuenta de conductor ha sido aprobada. ¡Ya puedes empezar a entregar pedidos!',
        type: 'success',
        timestamp: new Date()
      });
    }

    res.json({ message: 'Estado de aprobación actualizado', driver });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar aprobación', details: error.message });
  }
});

// --- RUTA DE STATS (DASHBOARD) ---

app.get('/api/stats', authenticateToken, async (req, res) => {
  try {
    const totalStores = await Store.count();
    const totalProducts = await Product.count(); 
    const totalOrders = await Order.count();
    
    // Filtros por rol (ejemplo simplificado para store_owner)
    let totalRevenue = 0;
    let activeOrders = 0;

    if (req.user.role === 'store_owner') {
      const userStores = await Store.findAll({ where: { ownerId: req.user.id } });
      const storeIds = userStores.map(s => s.id);

      const storeOrders = await Order.findAll({ 
        where: { storeId: { [sequelize.Sequelize.Op.in]: storeIds } } 
      });

      totalRevenue = storeOrders
        .filter(o => o.status === ORDER_STATES.DELIVERED)
        .reduce((sum, o) => sum + (o.subtotal - o.commission), 0); // Ingreso neto de la tienda

      activeOrders = storeOrders.filter(o => ![ORDER_STATES.DELIVERED, ORDER_STATES.CANCELLED].includes(o.status)).length;

    } else if (req.user.role === 'admin') {
      // Lógica de administrador (ingreso de la plataforma)
      const allOrders = await Order.findAll();
      totalRevenue = allOrders
        .filter(o => o.status === ORDER_STATES.DELIVERED)
        .reduce((sum, o) => sum + (o.commission + o.serviceFee), 0);
        
      activeOrders = allOrders.filter(o => ![ORDER_STATES.DELIVERED, ORDER_STATES.CANCELLED].includes(o.status)).length;
    }

    // Pedidos hoy (simplificado)
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    
    const ordersToday = await Order.count({
      where: {
        createdAt: { [sequelize.Sequelize.Op.gte]: startOfToday }
      }
    });

    res.json({ 
      stats: {
        totalStores,
        totalProducts,
        totalOrders,
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        activeOrders,
        ordersToday
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener estadísticas', details: error.message });
  }
});


// --- INICIO DEL SERVIDOR ---

async function startServer() {
  try {
    await testConnection();
    // await sequelize.sync({ alter: true }); // Usar solo en desarrollo
    console.log('✅ Base de datos sincronizada');

    server.listen(PORT, () => {
      console.log(`${'='.repeat(60)}`);
      console.log(`🚀 Servidor ejecutándose en http://localhost:${PORT}`);
      console.log(`🔑 JWT_SECRET configurado: ${JWT_SECRET.length > 10 ? 'OK' : 'FAIL'}`);
      console.log(`💰 Comisión: ${COMMISSION_RATE * 100}% | Tarifa de Servicio: ${SERVICE_FEE}`);
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

startServer();

process.on('SIGTERM', async () => {
  console.log('👋 SIGTERM recibido, cerrando servidor...');
  await sequelize.close();
  server.close(() => {
    console.log('Servidor cerrado.');
    process.exit(0);
  });
});