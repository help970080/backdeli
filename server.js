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

    const deliveryFee = store.deliveryFee;
    const total = subtotal + deliveryFee + SERVICE_FEE;
    const commission = subtotal * COMMISSION_RATE;

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
        { model: User, as: 'customer', attributes: ['id', 'name', 'phone', 'email'] },
        { model: User, as: 'driver', attributes: ['id', 'name', 'phone'] },
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

// ============================================
// OBTENER TODOS LOS CLIENTES (ADMIN)
// ============================================
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

// ============================================
// OBTENER TODAS LAS TIENDAS CON PROPIETARIOS (ADMIN)
// ============================================
app.get('/api/admin/stores', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const stores = await Store.findAll({
      include: [
        { 
          model: User, 
          as: 'owner',
          attributes: { exclude: ['password'] }
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    res.json({ stores });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener tiendas', details: error.message });
  }
});

// ============================================
// GESTIÓN DE COMISIONES - ADMINISTRADOR
// ============================================

// Obtener resumen de comisiones de todos los conductores
app.get('/api/admin/drivers/commissions', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const drivers = await User.findAll({
      where: { role: 'driver' },
      attributes: { exclude: ['password'] },
      order: [['createdAt', 'DESC']]
    });

    // Calcular comisiones pendientes por cada conductor
    const driversWithCommissions = await Promise.all(drivers.map(async (driver) => {
      // Obtener pedidos completados del conductor
      const completedOrders = await Order.findAll({
        where: {
          driverId: driver.id,
          status: 'delivered'
        },
        order: [['deliveredAt', 'DESC']]
      });

      // Calcular comisiones totales (plataforma)
      const totalCommissions = completedOrders.reduce((sum, order) => {
        return sum + (order.platformCommission || order.platformEarnings || 0);
      }, 0);

      // Calcular comisiones de esta semana
      const startOfWeek = new Date();
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay()); // Domingo
      startOfWeek.setHours(0, 0, 0, 0);

      const weekCommissions = completedOrders
        .filter(o => o.deliveredAt && new Date(o.deliveredAt) >= startOfWeek)
        .reduce((sum, order) => sum + (order.platformCommission || order.platformEarnings || 0), 0);

      // Obtener última fecha de pago (simulado por ahora, se puede agregar tabla de pagos)
      const lastPayment = driver.lastCommissionPayment || null;
      const daysSincePayment = lastPayment ? 
        Math.floor((new Date() - new Date(lastPayment)) / (1000 * 60 * 60 * 24)) : 999;

      return {
        id: driver.id,
        name: driver.name,
        email: driver.email,
        phone: driver.phone,
        approved: driver.approved,
        suspended: driver.suspended || false,
        balance: driver.balance || 0,
        totalDeliveries: driver.totalDeliveries || 0,
        totalEarnings: driver.totalEarnings || 0,
        totalCommissions,
        weekCommissions,
        pendingCommission: weekCommissions, // Lo que debe esta semana
        lastPayment,
        daysSincePayment,
        status: !driver.approved ? 'pending' : 
                driver.suspended ? 'suspended' :
                weekCommissions > 0 && daysSincePayment > 7 ? 'overdue' :
                weekCommissions > 0 ? 'active_debt' : 'clear',
        completedOrdersCount: completedOrders.length,
        createdAt: driver.createdAt
      };
    }));

    // Ordenar por estado (morosos primero)
    driversWithCommissions.sort((a, b) => {
      const statusOrder = { overdue: 0, active_debt: 1, suspended: 2, clear: 3, pending: 4 };
      return statusOrder[a.status] - statusOrder[b.status];
    });

    // Calcular totales generales
    const summary = {
      totalDrivers: drivers.length,
      activeDrivers: drivers.filter(d => d.approved && !d.suspended).length,
      suspendedDrivers: driversWithCommissions.filter(d => d.suspended).length,
      driversWithDebt: driversWithCommissions.filter(d => d.weekCommissions > 0).length,
      overdueDrivers: driversWithCommissions.filter(d => d.status === 'overdue').length,
      totalPendingCommissions: driversWithCommissions.reduce((sum, d) => sum + d.weekCommissions, 0),
      totalCommissionsAllTime: driversWithCommissions.reduce((sum, d) => sum + d.totalCommissions, 0)
    };

    res.json({ 
      drivers: driversWithCommissions,
      summary
    });
  } catch (error) {
    console.error('Error obteniendo comisiones:', error);
    res.status(500).json({ error: 'Error al obtener comisiones', details: error.message });
  }
});

// Suspender conductor por falta de pago
app.post('/api/admin/drivers/:driverId/suspend', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { driverId } = req.params;
    const { reason } = req.body;

    const driver = await User.findByPk(driverId);
    if (!driver) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    if (driver.role !== 'driver') {
      return res.status(400).json({ error: 'El usuario no es un conductor' });
    }

    await driver.update({ 
      suspended: true,
      suspensionReason: reason || 'Falta de pago de comisiones',
      suspensionDate: new Date()
    });

    // Notificar al conductor
    notifyUser(driver.id, {
      title: '⚠️ Cuenta suspendida',
      message: reason || 'Tu cuenta ha sido suspendida por falta de pago. Contacta a administración.',
      type: 'warning',
      timestamp: new Date()
    });

    res.json({ 
      message: 'Conductor suspendido exitosamente',
      driver: {
        id: driver.id,
        name: driver.name,
        suspended: driver.suspended
      }
    });
  } catch (error) {
    console.error('Error suspendiendo conductor:', error);
    res.status(500).json({ error: 'Error al suspender conductor', details: error.message });
  }
});

// Reactivar conductor
app.post('/api/admin/drivers/:driverId/activate', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { driverId } = req.params;
    const driver = await User.findByPk(driverId);

    if (!driver) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    await driver.update({ 
      suspended: false,
      suspensionReason: null,
      suspensionDate: null
    });

    // Notificar al conductor
    notifyUser(driver.id, {
      title: '✅ Cuenta reactivada',
      message: 'Tu cuenta ha sido reactivada. Ya puedes recibir pedidos nuevamente.',
      type: 'success',
      timestamp: new Date()
    });

    res.json({ 
      message: 'Conductor reactivado exitosamente',
      driver: {
        id: driver.id,
        name: driver.name,
        suspended: driver.suspended
      }
    });
  } catch (error) {
    console.error('Error reactivando conductor:', error);
    res.status(500).json({ error: 'Error al reactivar conductor', details: error.message });
  }
});

// Registrar pago de comisión
app.post('/api/admin/drivers/:driverId/register-payment', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { driverId } = req.params;
    const { amount, method, reference, notes } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Monto inválido' });
    }

    const driver = await User.findByPk(driverId);
    if (!driver) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    // Registrar el pago
    await driver.update({
      lastCommissionPayment: new Date(),
      totalCommissionsPaid: (driver.totalCommissionsPaid || 0) + parseFloat(amount)
    });

    // Notificar al conductor
    notifyUser(driver.id, {
      title: '💰 Pago registrado',
      message: `Se registró tu pago de $${amount}. ¡Gracias!`,
      type: 'success',
      timestamp: new Date()
    });

    // Log del pago (en producción, guardar en tabla de payments)
    console.log('Pago registrado:', {
      driverId,
      driverName: driver.name,
      amount,
      method,
      reference,
      notes,
      timestamp: new Date()
    });

    res.json({ 
      message: 'Pago registrado exitosamente',
      payment: {
        driverId: driver.id,
        driverName: driver.name,
        amount: parseFloat(amount),
        method,
        reference,
        timestamp: new Date()
      }
    });
  } catch (error) {
    console.error('Error registrando pago:', error);
    res.status(500).json({ error: 'Error al registrar pago', details: error.message });
  }
});

// Obtener historial de pedidos completados de un conductor (para verificar comisiones)
app.get('/api/admin/drivers/:driverId/completed-orders', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { driverId } = req.params;
    const { startDate, endDate } = req.query;

    const whereClause = {
      driverId: parseInt(driverId),
      status: 'delivered'
    };

    if (startDate || endDate) {
      whereClause.deliveredAt = {};
      if (startDate) {
        whereClause.deliveredAt[sequelize.Sequelize.Op.gte] = new Date(startDate);
      }
      if (endDate) {
        whereClause.deliveredAt[sequelize.Sequelize.Op.lte] = new Date(endDate);
      }
    }

    const orders = await Order.findAll({
      where: whereClause,
      include: [
        { model: Store, as: 'store', attributes: ['id', 'name'] },
        { model: User, as: 'customer', attributes: ['id', 'name', 'phone'] }
      ],
      order: [['deliveredAt', 'DESC']]
    });

    const totalCommissions = orders.reduce((sum, order) => {
      return sum + (order.platformCommission || order.platformEarnings || 0);
    }, 0);

    const totalDriverEarnings = orders.reduce((sum, order) => {
      return sum + (order.driverEarnings || 0);
    }, 0);

    res.json({ 
      orders,
      summary: {
        totalOrders: orders.length,
        totalCommissions,
        totalDriverEarnings,
        period: {
          start: startDate || 'inicio',
          end: endDate || 'hoy'
        }
      }
    });
  } catch (error) {
    console.error('Error obteniendo pedidos:', error);
    res.status(500).json({ error: 'Error al obtener pedidos', details: error.message });
  }
});
// ============================================
// ASIGNAR CONDUCTOR A PEDIDO - POST (usado por frontend)
// ============================================
app.post('/api/orders/:id/assign', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Solo conductores pueden asignarse pedidos' });
    }

    const { id } = req.params;
    const order = await Order.findByPk(id, {
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

    if (order.store && order.store.ownerId) {
      notifyUser(order.store.ownerId, {
        title: 'Conductor asignado',
        message: `${driver.name} recogerá el pedido #${order.orderNumber}`,
        type: 'info',
        orderId: order.id,
        timestamp: new Date()
      });
    }

    io.emit('order_update', { 
      orderId: order.id, 
      order 
    });

    res.json({ 
      message: 'Pedido asignado exitosamente',
      order 
    });
  } catch (error) {
    console.error('Error asignando pedido:', error);
    res.status(500).json({ error: 'Error al asignar pedido', details: error.message });
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
      const allOrders = await Order.findAll();
      const completedOrders = allOrders.filter(o => o.status === 'delivered');
      const today = new Date().toDateString();
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      
      // Calcular ganancias totales de la plataforma
      const totalPlatformEarnings = completedOrders.reduce((sum, o) => {
        return sum + (o.platformCommission || o.platformEarnings || 0);
      }, 0);
      
      // Ganancias de hoy
      const earningsToday = completedOrders
        .filter(o => o.deliveredAt && new Date(o.deliveredAt).toDateString() === today)
        .reduce((sum, o) => sum + (o.platformCommission || o.platformEarnings || 0), 0);
      
      // Ganancias del mes actual
      const earningsThisMonth = completedOrders
        .filter(o => o.deliveredAt && new Date(o.deliveredAt) >= startOfMonth)
        .reduce((sum, o) => sum + (o.platformCommission || o.platformEarnings || 0), 0);
      
      // Pedidos completados hoy
      const ordersToday = completedOrders.filter(o => {
        return o.deliveredAt && new Date(o.deliveredAt).toDateString() === today;
      }).length;
      
      // Pedidos completados este mes
      const ordersThisMonth = completedOrders.filter(o => {
        return o.deliveredAt && new Date(o.deliveredAt) >= startOfMonth;
      }).length;
      
      stats = {
        totalStores: await Store.count(),
        totalProducts: await Product.count(),
        totalOrders: allOrders.length,
        activeOrders: allOrders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length,
        completedOrders: completedOrders.length,
        totalPlatformEarnings,
        earningsToday,
        earningsThisMonth,
        ordersToday,
        ordersThisMonth,
        totalDrivers: await User.count({ where: { role: 'driver' } }),
        totalClients: await User.count({ where: { role: 'client' } }),
        pendingDrivers: await User.count({ where: { role: 'driver', approved: false } })
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

    // Migración automática de comisiones
    try {
      console.log('🔄 Verificando columnas para sistema de comisiones...');
      
      await sequelize.query(`
        ALTER TABLE "Users" 
        ADD COLUMN IF NOT EXISTS "suspended" BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS "suspensionReason" TEXT,
        ADD COLUMN IF NOT EXISTS "suspensionDate" TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "lastCommissionPayment" TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "totalCommissionsPaid" DECIMAL(10,2) DEFAULT 0;
      `);
      
      await sequelize.query(`
        CREATE INDEX IF NOT EXISTS "idx_users_suspended" ON "Users"("suspended");
      `);
      
      await sequelize.query(`
        CREATE INDEX IF NOT EXISTS "idx_users_last_payment" ON "Users"("lastCommissionPayment");
      `);
      
      console.log('✅ Sistema de comisiones configurado correctamente');
    } catch (error) {
      console.error('⚠️ Error en migración de comisiones:', error.message);
    }

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