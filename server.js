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

// 🔥 IMPORTAR CLOUDINARY
const { uploadImage, deleteImage } = require('./config/cloudinary');

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

// 🔥 IMPORTANTE: Configurar trust proxy para Render
// Render usa un proxy reverso, necesitamos confiar en el primer proxy
app.set('trust proxy', 1);

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

// 🔥 CONFIGURACIÓN DE MULTER CON MEMORIA (en vez de disco)
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

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    if (user.role === 'driver' && !user.approved) {
      return res.status(403).json({ error: 'Tu cuenta de conductor está pendiente de aprobación' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    const userResponse = user.toJSON();
    delete userResponse.password;

    res.json({ token, user: userResponse });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error al iniciar sesión', details: error.message });
  }
});

app.get('/api/users/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: { exclude: ['password'] }
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener perfil', details: error.message });
  }
});

app.put('/api/users/profile', authenticateToken, async (req, res) => {
  try {
    const { name, phone, address, vehicle } = req.body;
    const user = await User.findByPk(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    await user.update({
      ...(name && { name }),
      ...(phone && { phone }),
      ...(address && { address }),
      ...(vehicle && { vehicle })
    });

    const userResponse = user.toJSON();
    delete userResponse.password;

    res.json({ message: 'Perfil actualizado', user: userResponse });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar perfil', details: error.message });
  }
});

// 🔥 CREAR TIENDA CON CLOUDINARY
app.post('/api/stores', authenticateToken, upload.single('logo'), async (req, res) => {
  try {
    if (req.user.role !== 'store_owner') {
      return res.status(403).json({ error: 'Solo los dueños de tienda pueden crear tiendas' });
    }

    const { name, description, address, phone, category } = req.body;

    if (!name || !address || !phone) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    let logoUrl = null;
    
    // 🔥 Subir logo a Cloudinary si existe
    if (req.file) {
      console.log('📤 Subiendo logo a Cloudinary...');
      logoUrl = await uploadImage(req.file.buffer, 'stores', `store-${Date.now()}`);
      console.log('✅ Logo subido:', logoUrl);
    }

    const newStore = await Store.create({
      name,
      description,
      address,
      phone,
      category: category || 'general',
      logo: logoUrl,
      ownerId: req.user.id,
      isOpen: true,
      rating: 5.0
    });

    res.status(201).json({ message: 'Tienda creada exitosamente', store: newStore });
  } catch (error) {
    console.error('Error creando tienda:', error);
    res.status(500).json({ error: 'Error al crear tienda', details: error.message });
  }
});

app.get('/api/stores', async (req, res) => {
  try {
    const { category } = req.query;
    const where = category ? { category } : {};
    
    const stores = await Store.findAll({
      where,
      include: [
        {
          model: User,
          as: 'owner',
          attributes: ['id', 'name', 'phone']
        }
      ],
      order: [['rating', 'DESC']]
    });

    res.json({ stores });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener tiendas', details: error.message });
  }
});

app.get('/api/stores/:id', async (req, res) => {
  try {
    const store = await Store.findByPk(req.params.id, {
      include: [
        {
          model: User,
          as: 'owner',
          attributes: ['id', 'name', 'phone']
        }
      ]
    });

    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    res.json({ store });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener tienda', details: error.message });
  }
});

app.put('/api/stores/:id', authenticateToken, async (req, res) => {
  try {
    const store = await Store.findByPk(req.params.id);

    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    if (store.ownerId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    await store.update(req.body);

    res.json({ message: 'Tienda actualizada', store });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar tienda', details: error.message });
  }
});

// 🔥 CREAR PRODUCTO CON CLOUDINARY
app.post('/api/products', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    if (req.user.role !== 'store_owner') {
      return res.status(403).json({ error: 'Solo los dueños de tienda pueden crear productos' });
    }

    const { name, description, price, category, storeId } = req.body;

    if (!name || !price || !storeId) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const store = await Store.findByPk(storeId);
    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    if (store.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado para esta tienda' });
    }

    let imageUrl = null;
    
    // 🔥 Subir imagen a Cloudinary si existe
    if (req.file) {
      console.log('📤 Subiendo imagen de producto a Cloudinary...');
      imageUrl = await uploadImage(req.file.buffer, 'products', `product-${Date.now()}`);
      console.log('✅ Imagen subida:', imageUrl);
    }

    const newProduct = await Product.create({
      name,
      description,
      price: parseFloat(price),
      category: category || 'general',
      image: imageUrl,
      storeId: parseInt(storeId),
      available: true
    });

    res.status(201).json({ message: 'Producto creado exitosamente', product: newProduct });
  } catch (error) {
    console.error('Error creando producto:', error);
    res.status(500).json({ error: 'Error al crear producto', details: error.message });
  }
});

app.get('/api/stores/:storeId/products', async (req, res) => {
  try {
    const products = await Product.findAll({
      where: { storeId: req.params.storeId },
      order: [['available', 'DESC'], ['name', 'ASC']]
    });

    res.json({ products });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener productos', details: error.message });
  }
});

app.put('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    const product = await Product.findByPk(req.params.id, {
      include: [{ model: Store, as: 'store' }]
    });

    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    if (product.store.ownerId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    await product.update(req.body);

    res.json({ message: 'Producto actualizado', product });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar producto', details: error.message });
  }
});

// 🔥 ELIMINAR PRODUCTO Y SU IMAGEN DE CLOUDINARY
app.delete('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    const product = await Product.findByPk(req.params.id, {
      include: [{ model: Store, as: 'store' }]
    });

    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    if (product.store.ownerId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // 🔥 Eliminar imagen de Cloudinary si existe
    if (product.image) {
      console.log('🗑️ Eliminando imagen de Cloudinary...');
      await deleteImage(product.image);
      console.log('✅ Imagen eliminada');
    }

    await product.destroy();

    res.json({ message: 'Producto eliminado' });
  } catch (error) {
    console.error('Error eliminando producto:', error);
    res.status(500).json({ error: 'Error al eliminar producto', details: error.message });
  }
});

app.post('/api/orders', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ error: 'Solo los clientes pueden crear pedidos' });
    }

    const { storeId, items, deliveryAddress, notes } = req.body;

    if (!storeId || !items || items.length === 0 || !deliveryAddress) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const store = await Store.findByPk(storeId);
    if (!store || !store.isOpen) {
      return res.status(400).json({ error: 'Tienda no disponible' });
    }

    const productIds = items.map(item => item.productId);
    const products = await Product.findAll({
      where: {
        id: productIds,
        storeId: storeId,
        available: true
      }
    });

    if (products.length !== items.length) {
      return res.status(400).json({ error: 'Algunos productos no están disponibles' });
    }

    let subtotal = 0;
    const orderItems = items.map(item => {
      const product = products.find(p => p.id === item.productId);
      const itemTotal = product.price * item.quantity;
      subtotal += itemTotal;
      
      return {
        productId: product.id,
        name: product.name,
        price: product.price,
        quantity: item.quantity
      };
    });

    const deliveryFee = SERVICE_FEE;
    const total = subtotal + deliveryFee;

    const orderNumber = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const newOrder = await Order.create({
      orderNumber,
      customerId: req.user.id,
      storeId,
      items: orderItems,
      subtotal,
      deliveryFee,
      total,
      deliveryAddress,
      notes,
      status: ORDER_STATES.PENDING
    });

    const customer = await User.findByPk(req.user.id);

    notifyUser(store.ownerId, {
      title: '🔔 Nuevo pedido',
      message: `${customer.name} ha realizado un pedido de ${orderItems.length} productos`,
      type: 'success',
      orderId: newOrder.id,
      timestamp: new Date()
    });

    notifyRole('admin', {
      title: '📊 Nuevo pedido en el sistema',
      message: `Pedido ${orderNumber} - Total: $${total}`,
      type: 'info',
      orderId: newOrder.id,
      timestamp: new Date()
    });

    res.status(201).json({ 
      message: 'Pedido creado exitosamente',
      order: {
        ...newOrder.toJSON(),
        customer: {
          id: customer.id,
          name: customer.name,
          phone: customer.phone
        },
        store: {
          id: store.id,
          name: store.name,
          phone: store.phone
        }
      }
    });
  } catch (error) {
    console.error('Error creando pedido:', error);
    res.status(500).json({ error: 'Error al crear pedido', details: error.message });
  }
});

app.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    let whereClause = {};

    if (req.user.role === 'client') {
      whereClause.customerId = req.user.id;
    } else if (req.user.role === 'driver') {
      whereClause.driverId = req.user.id;
    } else if (req.user.role === 'store_owner') {
      const userStores = await Store.findAll({ where: { ownerId: req.user.id } });
      const storeIds = userStores.map(s => s.id);
      if (storeIds.length > 0) {
        whereClause.storeId = storeIds;
      } else {
        // Si no tiene tiendas, retornar array vacío
        return res.json({ orders: [] });
      }
    }

    const orders = await Order.findAll({
      where: whereClause,
      include: [
        {
          model: User,
          as: 'customer',
          attributes: ['id', 'name', 'phone', 'address']
        },
        {
          model: Store,
          as: 'store',
          attributes: ['id', 'name', 'direccion', 'phone'] // ✅ CORRECCIÓN APLICADA: 'direccion' (sin tilde)
        },
        {
          model: User,
          as: 'driver',
          attributes: ['id', 'name', 'phone', 'vehicle'],
          required: false
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    res.json({ orders });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener pedidos', details: error.message });
  }
});

app.get('/api/orders/:id', authenticateToken, async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id, {
      include: [
        {
          model: User,
          as: 'customer',
          attributes: ['id', 'name', 'phone', 'address']
        },
        {
          model: Store,
          as: 'store',
          attributes: ['id', 'name', 'direccion', 'phone'], // ✅ CORRECCIÓN APLICADA: 'direccion' (sin tilde)
          include: [{
            model: User,
            as: 'owner',
            attributes: ['id', 'name', 'phone']
          }]
        },
        {
          model: User,
          as: 'driver',
          attributes: ['id', 'name', 'phone', 'vehicle'],
          required: false
        }
      ]
    });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const isAuthorized = 
      order.customerId === req.user.id ||
      order.driverId === req.user.id ||
      order.store.ownerId === req.user.id ||
      req.user.role === 'admin';

    if (!isAuthorized) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    res.json({ order });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener pedido', details: error.message });
  }
});

app.put('/api/orders/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status, driverId } = req.body;
    const order = await Order.findByPk(req.params.id, {
      include: [
        { model: User, as: 'customer', attributes: ['id', 'name'] },
        { model: Store, as: 'store', attributes: ['id', 'name', 'ownerId'] },
        { model: User, as: 'driver', attributes: ['id', 'name'], required: false }
      ]
    });

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const currentStatePermissions = STATE_PERMISSIONS[order.status];
    
    if (!currentStatePermissions.canUpdate.includes(req.user.role)) {
      return res.status(403).json({ 
        error: `Solo ${currentStatePermissions.canUpdate.join(', ')} pueden actualizar este estado` 
      });
    }

    if (!currentStatePermissions.nextStates.includes(status)) {
      return res.status(400).json({ 
        error: `Transición inválida de ${order.status} a ${status}` 
      });
    }

    const updateData = { status };

    if (status === ORDER_STATES.ACCEPTED && !order.acceptedAt) {
      updateData.acceptedAt = new Date();
    } else if (status === ORDER_STATES.PICKED_UP && driverId) {
      updateData.driverId = driverId;
      updateData.pickedUpAt = new Date();
    } else if (status === ORDER_STATES.DELIVERED) {
      updateData.deliveredAt = new Date();
      
      const commission = order.subtotal * COMMISSION_RATE;
      const storeEarnings = order.subtotal - commission;
      const driverEarnings = order.deliveryFee;

      updateData.commission = commission;
      updateData.storeEarnings = storeEarnings;
      updateData.driverEarnings = driverEarnings;

      if (order.driverId) {
        const driver = await User.findByPk(order.driverId);
        await driver.update({
          totalDeliveries: driver.totalDeliveries + 1,
          totalEarnings: driver.totalEarnings + driverEarnings
        });
      }
    } else if (status === ORDER_STATES.CANCELLED) {
      updateData.cancelledAt = new Date();
    }

    await order.update(updateData);

    const notifications = {
      [ORDER_STATES.ACCEPTED]: {
        customer: { title: '✅ Pedido aceptado', message: `${order.store.name} ha aceptado tu pedido` },
        driver: { title: '🔔 Pedido disponible', message: `Nuevo pedido en ${order.store.name}` }
      },
      [ORDER_STATES.PREPARING]: {
        customer: { title: '👨‍🍳 Preparando tu pedido', message: `${order.store.name} está preparando tu pedido` }
      },
      [ORDER_STATES.READY]: {
        customer: { title: '✅ Pedido listo', message: 'Tu pedido está listo para ser recogido' },
        driver: { title: '📦 Pedido listo para recoger', message: `Pedido ${order.orderNumber} en ${order.store.name}` }
      },
      [ORDER_STATES.PICKED_UP]: {
        customer: { title: '🚗 Conductor recogió tu pedido', message: `${order.driver?.name} ha recogido tu pedido` },
        store_owner: { title: '✅ Pedido recogido', message: `Pedido ${order.orderNumber} recogido por ${order.driver?.name}` }
      },
      [ORDER_STATES.ON_WAY]: {
        customer: { title: '🛵 En camino', message: `${order.driver?.name} está en camino a tu ubicación` }
      },
      [ORDER_STATES.DELIVERED]: {
        customer: { title: '🎉 Pedido entregado', message: 'Gracias por tu compra' },
        store_owner: { title: '💰 Pedido completado', message: `Ganancia: $${storeEarnings.toFixed(2)}` },
        driver: { title: '💵 Entrega completada', message: `Ganancia: $${driverEarnings.toFixed(2)}` }
      },
      [ORDER_STATES.CANCELLED]: {
        customer: { title: '❌ Pedido cancelado', message: 'Tu pedido ha sido cancelado' },
        store_owner: { title: '⚠️ Pedido cancelado', message: `Pedido ${order.orderNumber} cancelado` }
      }
    };

    const statusNotifications = notifications[status];
    if (statusNotifications) {
      if (statusNotifications.customer) {
        notifyUser(order.customerId, {
          ...statusNotifications.customer,
          type: status === ORDER_STATES.DELIVERED ? 'success' : 'info',
          orderId: order.id,
          timestamp: new Date()
        });
      }
      if (statusNotifications.store_owner) {
        notifyUser(order.store.ownerId, {
          ...statusNotifications.store_owner,
          type: 'success',
          orderId: order.id,
          timestamp: new Date()
        });
      }
      if (statusNotifications.driver) {
        if (status === ORDER_STATES.ACCEPTED || status === ORDER_STATES.READY) {
          notifyRole('driver', {
            ...statusNotifications.driver,
            type: 'info',
            orderId: order.id,
            timestamp: new Date()
          });
        } else if (order.driverId) {
          notifyUser(order.driverId, {
            ...statusNotifications.driver,
            type: 'success',
            orderId: order.id,
            timestamp: new Date()
          });
        }
      }
    }

    const updatedOrder = await Order.findByPk(order.id, {
      include: [
        { model: User, as: 'customer', attributes: ['id', 'name', 'phone'] },
        { model: Store, as: 'store', attributes: ['id', 'name', 'phone'] },
        { model: User, as: 'driver', attributes: ['id', 'name', 'phone', 'vehicle'], required: false }
      ]
    });

    res.json({ message: 'Estado actualizado', order: updatedOrder });
  } catch (error) {
    console.error('Error actualizando estado:', error);
    res.status(500).json({ error: 'Error al actualizar estado del pedido', details: error.message });
  }
});

app.get('/api/orders/available/drivers', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Solo los conductores pueden ver pedidos disponibles' });
    }

    const availableOrders = await Order.findAll({
      where: {
        status: [ORDER_STATES.READY],
        driverId: null
      },
      include: [
        {
          model: Store,
          as: 'store',
          attributes: ['id', 'name', 'address', 'phone']
        },
        {
          model: User,
          as: 'customer',
          attributes: ['id', 'name', 'address']
        }
      ],
      order: [['createdAt', 'ASC']]
    });

    res.json({ orders: availableOrders });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener pedidos disponibles', details: error.message });
  }
});

app.get('/api/drivers', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo los administradores pueden ver conductores' });
    }

    const drivers = await User.findAll({
      where: { role: 'driver' },
      attributes: { exclude: ['password'] },
      order: [['createdAt', 'DESC']]
    });

    res.json({ drivers });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener conductores', details: error.message });
  }
});

app.put('/api/drivers/:id/toggle-availability', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'driver' || req.user.id !== parseInt(req.params.id)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const driver = await User.findByPk(req.params.id);
    
    if (!driver || driver.role !== 'driver') {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    await driver.update({ available: !driver.available });

    const userResponse = driver.toJSON();
    delete userResponse.password;

    res.json({ 
      message: `Ahora estás ${driver.available ? 'disponible' : 'no disponible'}`,
      driver: userResponse
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar disponibilidad', details: error.message });
  }
});

app.put('/api/drivers/:id/approve', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo los administradores pueden aprobar conductores' });
    }

    const driver = await User.findByPk(req.params.id);
    
    if (!driver || driver.role !== 'driver') {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    await driver.update({ approved: true });

    notifyUser(driver.id, {
      title: '✅ Cuenta aprobada',
      message: 'Tu cuenta de conductor ha sido aprobada. Ya puedes comenzar a trabajar.',
      type: 'success',
      timestamp: new Date()
    });

    const userResponse = driver.toJSON();
    delete userResponse.password;

    res.json({ message: 'Conductor aprobado', driver: userResponse });
  } catch (error) {
    res.status(500).json({ error: 'Error al aprobar conductor', details: error.message });
  }
});

app.delete('/api/drivers/:id/reject', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Solo los administradores pueden rechazar conductores' });
    }

    const driver = await User.findByPk(req.params.id);
    
    if (!driver || driver.role !== 'driver') {
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
      
      // ✅ Solución para el error 'no encuentra PEDIDO'
      if (storeIds.length === 0) {
        return res.json({ stats: {
          totalStores: 0,
          totalProducts: 0,
          totalOrders: 0,
          totalRevenue: 0,
          activeOrders: 0,
          ordersToday: 0
        }});
      }
      
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
    }

    res.json({ stats });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estadísticas', details: error.message });
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
      console.log(`🛡️  Seguridad: Helmet ✅ | Rate Limiting ✅ | Bcrypt ✅`);
      console.log(`☁️  Cloudinary: Activado para imágenes`);
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