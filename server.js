require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

// Mapa de usuarios conectados
const userSockets = new Map();

// ============================================
// FUNCIONES DE NOTIFICACIÓN
// ============================================

function notifyUser(userId, notification) {
  const socketId = userSockets.get(userId.toString());
  if (socketId) {
    io.to(socketId).emit('notification', notification);
    console.log(`📬 Notificación enviada a usuario ${userId}:`, notification.title);
    return true;
  }
  console.log(`⚠️ Usuario ${userId} no está conectado`);
  return false;
}

function notifyAll(notification) {
  io.emit('notification', notification);
  console.log(`📢 Notificación enviada a TODOS:`, notification.title);
}

function notifyRole(role, notification) {
  const usersOfRole = database.users
    .filter(u => u.role === role)
    .map(u => u.id);
  
  let sentCount = 0;
  usersOfRole.forEach(userId => {
    if (notifyUser(userId, notification)) {
      sentCount++;
    }
  });
  
  console.log(`📢 Notificación enviada a rol ${role}: ${sentCount}/${usersOfRole.length} usuarios`);
  return sentCount;
}

function notifyMultiple(userIds, notification) {
  let sentCount = 0;
  userIds.forEach(userId => {
    if (notifyUser(userId, notification)) {
      sentCount++;
    }
  });
  console.log(`📬 Notificación enviada a ${sentCount}/${userIds.length} usuarios`);
  return sentCount;
}

// Crear carpetas necesarias
const uploadsDir = path.join(__dirname, 'uploads');
const storesDir = path.join(__dirname, 'uploads/stores');
const productsDir = path.join(__dirname, 'uploads/products');

[uploadsDir, storesDir, productsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Configuración de multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = req.body.type || 'general';
    const dest = type === 'store' ? storesDir : 
                  type === 'product' ? productsDir : uploadsDir;
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Constantes
const JWT_SECRET = process.env.JWT_SECRET || 'tu-secreto-super-seguro-CAMBIAR-EN-PRODUCCION';
const PORT = process.env.PORT || 3000;
const COMMISSION_RATE = parseFloat(process.env.COMMISSION_RATE) || 0.20;
const SERVICE_FEE = parseFloat(process.env.SERVICE_FEE) || 10;
const DB_FILE = process.env.DB_FILE || 'database.json';

// ============================================
// ESTADOS DE PEDIDOS Y PERMISOS
// ============================================

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

// Base de datos simulada
let database = {
  users: [
    {
      id: 1,
      email: 'cliente@delivery.com',
      password: 'cliente123',
      name: 'Juan Cliente',
      phone: '5512345678',
      role: 'client',
      address: 'Av. Insurgentes Sur 1234, CDMX',
      createdAt: new Date()
    },
    {
      id: 2,
      email: 'conductor@delivery.com',
      password: 'conductor123',
      name: 'Pedro Conductor',
      phone: '5587654321',
      role: 'driver',
      vehicle: 'Moto Honda 2020',
      license: 'ABC123456',
      available: true,
      approved: true,
      currentLocation: { lat: 19.4326, lng: -99.1332 },
      rating: 4.8,
      totalDeliveries: 0,
      totalEarnings: 0,
      createdAt: new Date()
    },
    {
      id: 3,
      email: 'admin@delivery.com',
      password: 'admin123',
      name: 'Administrador',
      phone: '5500000000',
      role: 'admin',
      createdAt: new Date()
    },
    {
      id: 4,
      email: 'tienda@delivery.com',
      password: 'tienda123',
      name: 'María Comerciante',
      phone: '5599887766',
      role: 'store_owner',
      createdAt: new Date()
    }
  ],
  
  stores: [
    {
      id: 1,
      name: 'Tacos El Güero',
      description: 'Los mejores tacos de la ciudad',
      category: 'Mexicana',
      image: '/uploads/stores/tacos.jpg',
      rating: 4.5,
      deliveryTime: '20-30 min',
      deliveryFee: 35,
      minOrder: 50,
      isOpen: true,
      ownerId: 4,
      location: { lat: 19.4326, lng: -99.1332, address: 'Av. Reforma 123' },
      createdAt: new Date()
    },
    {
      id: 2,
      name: 'Pizzería Napolitana',
      description: 'Auténtica pizza italiana',
      category: 'Italiana',
      image: '/uploads/stores/pizza.jpg',
      rating: 4.7,
      deliveryTime: '30-40 min',
      deliveryFee: 40,
      minOrder: 80,
      isOpen: true,
      ownerId: 4,
      location: { lat: 19.4330, lng: -99.1340, address: 'Calle Roma 456' },
      createdAt: new Date()
    },
    {
      id: 3,
      name: 'Sushi Tokyo',
      description: 'Sushi fresco y rolls especiales',
      category: 'Japonesa',
      image: '/uploads/stores/sushi.jpg',
      rating: 4.8,
      deliveryTime: '25-35 min',
      deliveryFee: 45,
      minOrder: 100,
      isOpen: true,
      ownerId: 4,
      location: { lat: 19.4335, lng: -99.1335, address: 'Av. Chapultepec 789' },
      createdAt: new Date()
    }
  ],

  products: [
    {
      id: 1,
      storeId: 1,
      name: 'Tacos de Pastor',
      description: 'Tradicionales tacos al pastor con piña',
      price: 45,
      image: '/uploads/products/tacos-pastor.jpg',
      category: 'Tacos',
      available: true,
      preparationTime: 10
    },
    {
      id: 2,
      storeId: 1,
      name: 'Tacos de Bistec',
      description: 'Tacos de bistec con cebolla y cilantro',
      price: 50,
      image: '/uploads/products/tacos-bistec.jpg',
      category: 'Tacos',
      available: true,
      preparationTime: 12
    },
    {
      id: 3,
      storeId: 2,
      name: 'Pizza Margarita',
      description: 'Tomate, mozzarella y albahaca',
      price: 180,
      image: '/uploads/products/pizza-margarita.jpg',
      category: 'Pizzas',
      available: true,
      preparationTime: 25
    },
    {
      id: 4,
      storeId: 2,
      name: 'Pizza Pepperoni',
      description: 'Pepperoni italiano y queso mozzarella',
      price: 200,
      image: '/uploads/products/pizza-pepperoni.jpg',
      category: 'Pizzas',
      available: true,
      preparationTime: 25
    },
    {
      id: 5,
      storeId: 3,
      name: 'California Roll',
      description: 'Cangrejo, aguacate y pepino',
      price: 120,
      image: '/uploads/products/california-roll.jpg',
      category: 'Rolls',
      available: true,
      preparationTime: 15
    },
    {
      id: 6,
      storeId: 3,
      name: 'Sashimi Mixto',
      description: 'Selección de pescados frescos',
      price: 250,
      image: '/uploads/products/sashimi.jpg',
      category: 'Sashimi',
      available: true,
      preparationTime: 10
    }
  ],

  orders: []
};

// ============================================
// FUNCIONES DE PERSISTENCIA
// ============================================

function saveDatabase() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(database, null, 2));
    console.log('💾 Base de datos guardada');
  } catch (error) {
    console.error('❌ Error guardando base de datos:', error);
  }
}

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      database = JSON.parse(data);
      console.log('📂 Base de datos cargada desde archivo');
    } else {
      console.log('📝 Usando base de datos inicial');
      saveDatabase();
    }
  } catch (error) {
    console.error('❌ Error cargando base de datos:', error);
    console.log('📝 Usando base de datos inicial');
  }
}

loadDatabase();

setInterval(() => {
  saveDatabase();
}, 5 * 60 * 1000);

// ============================================
// MIDDLEWARE DE AUTENTICACIÓN
// ============================================

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

// ============================================
// AUTENTICACIÓN
// ============================================

app.post('/api/auth/register', (req, res) => {
  try {
    const { email, password, name, phone, role, vehicle, license, address, inePhoto, vehiclePhoto } = req.body;

    if (!email || !password || !name || !phone || !role) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const existingUser = database.users.find(u => u.email === email);
    if (existingUser) {
      return res.status(400).json({ error: 'El email ya está registrado' });
    }

    const newUser = {
      id: database.users.length + 1,
      email,
      password,
      name,
      phone,
      role,
      createdAt: new Date()
    };

    if (role === 'driver') {
      newUser.vehicle = vehicle;
      newUser.license = license;
      newUser.inePhoto = inePhoto;
      newUser.vehiclePhoto = vehiclePhoto;
      newUser.available = false;
      newUser.approved = false;
      newUser.currentLocation = { lat: 19.4326, lng: -99.1332 };
      newUser.rating = 5.0;
      newUser.totalDeliveries = 0;
      newUser.totalEarnings = 0;
    } else if (role === 'client') {
      newUser.address = address;
    }

    database.users.push(newUser);
    saveDatabase();

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

    const { password: _, ...userWithoutPassword } = newUser;
    res.status(201).json({ 
      message: 'Usuario registrado exitosamente',
      token,
      user: userWithoutPassword
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al registrar usuario', details: error.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña son requeridos' });
    }

    const user = database.users.find(u => u.email === email && u.password === password);

    if (!user) {
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

    const { password: _, ...userWithoutPassword } = user;
    res.json({ 
      message: 'Login exitoso',
      token,
      user: userWithoutPassword
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al iniciar sesión', details: error.message });
  }
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  try {
    const user = database.users.find(u => u.id === req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const { password, ...userWithoutPassword } = user;
    res.json({ user: userWithoutPassword });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener usuario', details: error.message });
  }
});

app.get('/api/users/profile', authenticateToken, (req, res) => {
  try {
    const user = database.users.find(u => u.id === req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const { password, ...userWithoutPassword } = user;
    res.json({ user: userWithoutPassword });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener usuario', details: error.message });
  }
});

// ============================================
// TIENDAS
// ============================================

app.get('/api/stores', (req, res) => {
  try {
    const { category } = req.query;
    let stores = database.stores;

    if (category) {
      stores = stores.filter(s => s.category === category);
    }

    res.json({ stores });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener tiendas', details: error.message });
  }
});

app.get('/api/stores/:storeId', (req, res) => {
  try {
    const { storeId } = req.params;
    const store = database.stores.find(s => s.id === parseInt(storeId));

    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    const products = database.products.filter(p => p.storeId === store.id);

    res.json({ store, products });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener tienda', details: error.message });
  }
});

app.post('/api/stores', authenticateToken, upload.single('image'), (req, res) => {
  try {
    if (req.user.role !== 'store_owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { name, description, category, deliveryTime, deliveryFee, minOrder, address, lat, lng } = req.body;

    const newStore = {
      id: database.stores.length + 1,
      name,
      description,
      category,
      image: req.file ? `/uploads/stores/${req.file.filename}` : null,
      rating: 5.0,
      deliveryTime,
      deliveryFee: parseFloat(deliveryFee),
      minOrder: parseFloat(minOrder),
      isOpen: true,
      ownerId: req.user.id,
      location: { lat: parseFloat(lat), lng: parseFloat(lng), address },
      createdAt: new Date()
    };

    database.stores.push(newStore);
    saveDatabase();

    res.status(201).json({ 
      message: 'Tienda creada exitosamente',
      store: newStore 
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al crear tienda', details: error.message });
  }
});

app.put('/api/stores/:storeId', authenticateToken, upload.single('image'), (req, res) => {
  try {
    const { storeId } = req.params;
    const store = database.stores.find(s => s.id === parseInt(storeId));

    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    if (store.ownerId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { name, description, category, deliveryTime, deliveryFee, minOrder, isOpen, address, lat, lng } = req.body;

    if (name) store.name = name;
    if (description) store.description = description;
    if (category) store.category = category;
    if (deliveryTime) store.deliveryTime = deliveryTime;
    if (deliveryFee) store.deliveryFee = parseFloat(deliveryFee);
    if (minOrder) store.minOrder = parseFloat(minOrder);
    if (typeof isOpen !== 'undefined') store.isOpen = isOpen === 'true' || isOpen === true;
    if (req.file) store.image = `/uploads/stores/${req.file.filename}`;
    if (address || lat || lng) {
      store.location = {
        lat: lat ? parseFloat(lat) : store.location.lat,
        lng: lng ? parseFloat(lng) : store.location.lng,
        address: address || store.location.address
      };
    }

    saveDatabase();
    res.json({ 
      message: 'Tienda actualizada exitosamente',
      store 
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar tienda', details: error.message });
  }
});

app.delete('/api/stores/:storeId', authenticateToken, (req, res) => {
  try {
    const { storeId } = req.params;
    const storeIndex = database.stores.findIndex(s => s.id === parseInt(storeId));

    if (storeIndex === -1) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    const store = database.stores[storeIndex];

    if (store.ownerId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    database.stores.splice(storeIndex, 1);
    database.products = database.products.filter(p => p.storeId !== parseInt(storeId));
    saveDatabase();

    res.json({ message: 'Tienda eliminada exitosamente' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar tienda', details: error.message });
  }
});

// ============================================
// PRODUCTOS
// ============================================

app.get('/api/stores/:storeId/products', (req, res) => {
  try {
    const { storeId } = req.params;
    const { category } = req.query;
    
    let products = database.products.filter(p => p.storeId === parseInt(storeId));

    if (category) {
      products = products.filter(p => p.category === category);
    }

    res.json({ products });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener productos', details: error.message });
  }
});

app.post('/api/products', authenticateToken, upload.single('image'), (req, res) => {
  try {
    if (req.user.role !== 'store_owner' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { storeId, name, description, price, category, preparationTime } = req.body;
    
    const store = database.stores.find(s => s.id === parseInt(storeId));
    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    if (store.ownerId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado para esta tienda' });
    }

    const newProduct = {
      id: database.products.length + 1,
      storeId: parseInt(storeId),
      name,
      description,
      price: parseFloat(price),
      image: req.file ? `/uploads/products/${req.file.filename}` : null,
      category,
      available: true,
      preparationTime: parseInt(preparationTime) || 15
    };

    database.products.push(newProduct);
    saveDatabase();

    res.status(201).json({ 
      message: 'Producto creado exitosamente',
      product: newProduct 
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al crear producto', details: error.message });
  }
});

app.put('/api/products/:productId', authenticateToken, upload.single('image'), (req, res) => {
  try {
    const { productId } = req.params;
    const product = database.products.find(p => p.id === parseInt(productId));

    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    const store = database.stores.find(s => s.id === product.storeId);
    if (store.ownerId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { name, description, price, category, available, preparationTime } = req.body;

    if (name) product.name = name;
    if (description) product.description = description;
    if (price) product.price = parseFloat(price);
    if (category) product.category = category;
    if (typeof available !== 'undefined') product.available = available === 'true' || available === true;
    if (preparationTime) product.preparationTime = parseInt(preparationTime);
    if (req.file) product.image = `/uploads/products/${req.file.filename}`;

    saveDatabase();
    res.json({ 
      message: 'Producto actualizado exitosamente',
      product 
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar producto', details: error.message });
  }
});

app.delete('/api/products/:productId', authenticateToken, (req, res) => {
  try {
    const { productId } = req.params;
    const productIndex = database.products.findIndex(p => p.id === parseInt(productId));

    if (productIndex === -1) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }

    const product = database.products[productIndex];
    const store = database.stores.find(s => s.id === product.storeId);

    if (store.ownerId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    database.products.splice(productIndex, 1);
    saveDatabase();
    res.json({ message: 'Producto eliminado exitosamente' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar producto', details: error.message });
  }
});

// ============================================
// PEDIDOS
// ============================================

app.post('/api/orders', authenticateToken, (req, res) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ error: 'Solo clientes pueden crear pedidos' });
    }

    const { storeId, items, deliveryAddress, paymentMethod, notes } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'El pedido debe tener al menos un producto' });
    }

    const store = database.stores.find(s => s.id === storeId);
    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    if (!store.isOpen) {
      return res.status(400).json({ error: 'La tienda está cerrada' });
    }

    let subtotal = 0;
    const orderItems = items.map(item => {
      const product = database.products.find(p => p.id === item.productId);
      if (!product) {
        throw new Error(`Producto ${item.productId} no encontrado`);
      }
      if (!product.available) {
        throw new Error(`Producto ${product.name} no disponible`);
      }
      const itemTotal = product.price * item.quantity;
      subtotal += itemTotal;
      return {
        productId: product.id,
        name: product.name,
        price: product.price,
        quantity: item.quantity,
        total: itemTotal
      };
    });

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
    const orderNumber = database.orders.length + 1;
    const customer = database.users.find(u => u.id === req.user.id);

    const newOrder = {
      id: database.orders.length + 1,
      orderNumber: orderNumber,
      customerId: req.user.id,
      storeId,
      storeName: store.name,
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
      driverEarnings: 0,
      createdAt: new Date(),
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone
      },
      store: {
        id: store.id,
        name: store.name,
        location: store.location
      },
      statusHistory: [
        {
          status: ORDER_STATES.PENDING,
          timestamp: new Date(),
          note: 'Pedido creado'
        }
      ]
    };

    database.orders.push(newOrder);
    saveDatabase();

    notifyUser(store.ownerId, {
      title: '¡Nuevo pedido!',
      message: `Pedido #${newOrder.orderNumber} - ${total.toFixed(2)}`,
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

app.get('/api/orders', authenticateToken, (req, res) => {
  try {
    const { status } = req.query;
    let orders = [];

    if (req.user.role === 'client') {
      orders = database.orders.filter(o => o.customerId === req.user.id);
    } else if (req.user.role === 'driver') {
      orders = database.orders.filter(o => 
        o.driverId === req.user.id || 
        o.status === ORDER_STATES.READY
      );
    } else if (req.user.role === 'store_owner') {
      const userStores = database.stores.filter(s => s.ownerId === req.user.id);
      const storeIds = userStores.map(s => s.id);
      orders = database.orders.filter(o => storeIds.includes(o.storeId));
    } else if (req.user.role === 'admin') {
      orders = database.orders;
    }

    if (status) {
      orders = orders.filter(o => o.status === status);
    }

    orders = orders.map(order => {
      const store = database.stores.find(s => s.id === order.storeId);
      const customer = database.users.find(u => u.id === order.customerId);
      const driver = order.driverId ? database.users.find(u => u.id === order.driverId) : null;

      return {
        ...order,
        store: store ? {
          id: store.id,
          name: store.name,
          location: store.location
        } : order.store,
        customer: customer ? {
          id: customer.id,
          name: customer.name,
          phone: customer.phone
        } : order.customer,
        driver: driver ? {
          id: driver.id,
          name: driver.name,
          phone: driver.phone,
          vehicle: driver.vehicle
        } : order.driver
      };
    });

    orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ orders });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener pedidos', details: error.message });
  }
});

app.get('/api/orders/:orderId', authenticateToken, (req, res) => {
  try {
    const { orderId } = req.params;
    const order = database.orders.find(o => o.id === parseInt(orderId));

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const hasAccess = 
      req.user.role === 'admin' ||
      order.customerId === req.user.id ||
      order.driverId === req.user.id ||
      (req.user.role === 'store_owner' && 
       database.stores.find(s => s.id === order.storeId)?.ownerId === req.user.id);

    if (!hasAccess) {
      return res.status(403).json({ error: 'No tienes acceso a este pedido' });
    }

    res.json({ order });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener pedido', details: error.message });
  }
});

app.put('/api/orders/:orderId/status', authenticateToken, (req, res) => {
  try {
    const { orderId } = req.params;
    const { status, note } = req.body;
    
    const order = database.orders.find(o => o.id === parseInt(orderId));

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const currentStatePermissions = STATE_PERMISSIONS[order.status];

    if (!currentStatePermissions.canUpdate.includes(req.user.role)) {
      return res.status(403).json({ 
        error: `Solo ${currentStatePermissions.canUpdate.join(' o ')} pueden actualizar este estado` 
      });
    }

    if (!currentStatePermissions.nextStates.includes(status)) {
      return res.status(400).json({ 
        error: `No se puede cambiar de ${order.status} a ${status}`,
        allowedStates: currentStatePermissions.nextStates
      });
    }

    const oldStatus = order.status;
    order.status = status;
    order.statusHistory.push({
      status,
      timestamp: new Date(),
      note: note || '',
      updatedBy: req.user.id
    });

    // 🎯 PICKED_UP: ASIGNAR CONDUCTOR Y CALCULAR GANANCIAS
    if (status === ORDER_STATES.PICKED_UP) {
      order.pickedUpAt = new Date();
      
      // Asignar conductor al pedido si no está asignado
      if (!order.driverId && req.user.role === 'driver') {
        order.driverId = req.user.id;
        const driver = database.users.find(u => u.id === req.user.id);
        
        if (driver) {
          // Calcular distancia (puedes mejorar esto con una API real)
          const deliveryDistance = order.distance || 5.2;
          
          // Fórmula: 70% del delivery fee + $5 por km
          const driverEarnings = (order.deliveryFee * 0.7) + (deliveryDistance * 5);
          order.driverEarnings = driverEarnings;
          
          // Guardar info del conductor en el pedido
          order.driver = {
            id: driver.id,
            name: driver.name,
            phone: driver.phone,
            vehicle: driver.vehicle
          };
          
          console.log(`✅ Conductor ${driver.name} asignado al pedido #${order.orderNumber} - Ganancia: ${driverEarnings.toFixed(2)}`);
          
          // Notificar al cliente
          notifyUser(order.customerId, {
            title: '🚗 Conductor asignado',
            message: `${driver.name} ha recogido tu pedido`,
            type: 'info',
            orderId: order.id,
            timestamp: new Date()
          });
        }
      }
    } 
    // 💰 DELIVERED: REGISTRAR COBRO AL CONDUCTOR
    else if (status === ORDER_STATES.DELIVERED) {
      order.deliveredAt = new Date();
      
      // Registrar pago al conductor
      const driver = database.users.find(u => u.id === order.driverId);
      if (driver) {
        driver.totalDeliveries += 1;
        driver.totalEarnings += order.driverEarnings;
        
        console.log(`💵 Pago registrado: ${driver.name} ganó ${order.driverEarnings.toFixed(2)} - Total acumulado: ${driver.totalEarnings.toFixed(2)}`);
        
        // Notificar al conductor
        notifyUser(driver.id, {
          title: '💰 Pago registrado',
          message: `Ganaste ${order.driverEarnings.toFixed(2)} por el pedido #${order.orderNumber}`,
          type: 'success',
          timestamp: new Date()
        });
      }

      // Calcular ganancias de la plataforma
      order.platformEarnings = order.commission + order.serviceFee;
      
      // Notificar a la tienda
      const store = database.stores.find(s => s.id === order.storeId);
      if (store) {
        notifyUser(store.ownerId, {
          title: 'Pedido entregado',
          message: `Pedido #${order.orderNumber} entregado exitosamente`,
          type: 'success',
          orderId: order.id,
          timestamp: new Date()
        });
      }
    } 
    else if (status === ORDER_STATES.ACCEPTED) {
      order.acceptedAt = new Date();
      
      const store = database.stores.find(s => s.id === order.storeId);
      notifyRole('admin', {
        title: 'Pedido aceptado',
        message: `Pedido #${order.orderNumber} aceptado por ${store.name}`,
        type: 'info',
        orderId: order.id,
        timestamp: new Date()
      });
    } 
    else if (status === ORDER_STATES.READY) {
      order.readyAt = new Date();
      
      const store = database.stores.find(s => s.id === order.storeId);
      
      // Notificar a todos los conductores disponibles
      notifyRole('driver', {
        title: '¡Nuevo pedido disponible!',
        message: `Pedido #${order.orderNumber} listo para recoger en ${store.name}`,
        type: 'success',
        orderId: order.id,
        timestamp: new Date()
      });
    }
    
    const store = database.stores.find(s => s.id === order.storeId);
    
    // Notificar al cliente sobre el cambio de estado
    notifyUser(order.customerId, {
      title: 'Actualización de pedido',
      message: getStatusMessage(status, order),
      type: 'info',
      orderId: order.id,
      status: status,
      timestamp: new Date()
    });

    saveDatabase();
    res.json({ 
      message: 'Estado actualizado exitosamente',
      order 
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar estado', details: error.message });
  }
});

function getStatusMessage(status, order) {
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

app.put('/api/orders/:orderId/assign', authenticateToken, (req, res) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Solo conductores pueden asignarse pedidos' });
    }

    const { orderId } = req.params;
    const order = database.orders.find(o => o.id === parseInt(orderId));

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    if (order.status !== ORDER_STATES.READY) {
      return res.status(400).json({ error: 'El pedido no está listo para ser recogido' });
    }

    if (order.driverId) {
      return res.status(400).json({ error: 'El pedido ya tiene un conductor asignado' });
    }

    const driver = database.users.find(u => u.id === req.user.id);
    if (!driver.approved || !driver.available) {
      return res.status(403).json({ error: 'No estás disponible para tomar pedidos' });
    }

    order.driverId = req.user.id;
    order.driverName = driver.name;
    order.assignedAt = new Date();
    
    const deliveryDistance = 5;
    const driverEarnings = (order.deliveryFee * 0.7) + (deliveryDistance * 5);
    order.driverEarnings = driverEarnings;

    const store = database.stores.find(s => s.id === order.storeId);

    notifyUser(order.customerId, {
      title: 'Conductor asignado',
      message: `${driver.name} recogerá tu pedido`,
      type: 'info',
      orderId: order.id,
      timestamp: new Date()
    });

    saveDatabase();
    res.json({ 
      message: 'Pedido asignado exitosamente',
      order,
      earnings: driverEarnings
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al asignar pedido', details: error.message });
  }
});

// ============================================
// CONDUCTORES
// ============================================

app.get('/api/drivers', authenticateToken, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const drivers = database.users
      .filter(u => u.role === 'driver')
      .map(({ password, ...driver }) => driver);

    res.json({ drivers });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener conductores', details: error.message });
  }
});

app.get('/api/drivers/available', (req, res) => {
  try {
    const drivers = database.users
      .filter(u => u.role === 'driver' && u.available && u.approved)
      .map(({ password, email, ...driver }) => ({
        ...driver,
        activeOrders: database.orders.filter(o => 
          o.driverId === driver.id && 
          !['delivered', 'cancelled'].includes(o.status)
        ).length
      }));

    res.json({ drivers });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener conductores', details: error.message });
  }
});

app.put('/api/drivers/:driverId/availability', authenticateToken, (req, res) => {
  try {
    const { driverId } = req.params;
    const { available } = req.body;

    if (req.user.id !== parseInt(driverId) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const driver = database.users.find(u => u.id === parseInt(driverId) && u.role === 'driver');

    if (!driver) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    if (!driver.approved) {
      return res.status(403).json({ error: 'Tu cuenta aún no ha sido aprobada' });
    }

    driver.available = available;

    saveDatabase();
    res.json({ 
      message: `Estado cambiado a ${available ? 'disponible' : 'no disponible'}`,
      driver: { id: driver.id, available: driver.available }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar disponibilidad', details: error.message });
  }
});

app.put('/api/drivers/:driverId/location', authenticateToken, (req, res) => {
  try {
    const { driverId } = req.params;
    const { lat, lng } = req.body;

    if (req.user.id !== parseInt(driverId)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const driver = database.users.find(u => u.id === parseInt(driverId) && u.role === 'driver');

    if (!driver) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    driver.currentLocation = { lat, lng };

    res.json({ 
      message: 'Ubicación actualizada',
      location: driver.currentLocation
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar ubicación', details: error.message });
  }
});

// ============================================
// ADMIN
// ============================================

app.get('/api/admin/stats', authenticateToken, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const allOrders = database.orders;
    const completedOrders = allOrders.filter(o => o.status === 'delivered');
    const today = new Date().toDateString();

    const stats = {
      totalOrders: allOrders.length,
      completedOrders: completedOrders.length,
      pendingOrders: allOrders.filter(o => o.status === 'pending').length,
      activeOrders: allOrders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length,
      cancelledOrders: allOrders.filter(o => o.status === 'cancelled').length,
      totalPlatformEarnings: completedOrders.reduce((sum, o) => sum + (o.platformEarnings || 0), 0),
      totalCommissions: completedOrders.reduce((sum, o) => sum + (o.commission || 0), 0),
      totalServiceFees: completedOrders.reduce((sum, o) => sum + (o.serviceFee || 0), 0),
      totalDriverEarnings: completedOrders.reduce((sum, o) => sum + (o.driverEarnings || 0), 0),
      totalRevenue: completedOrders.reduce((sum, o) => sum + o.total, 0),
      totalDrivers: database.users.filter(u => u.role === 'driver' && u.approved).length,
      pendingDrivers: database.users.filter(u => u.role === 'driver' && !u.approved).length,
      availableDrivers: database.users.filter(u => u.role === 'driver' && u.available && u.approved).length,
      totalClients: database.users.filter(u => u.role === 'client').length,
      totalStores: database.stores.length,
      totalProducts: database.products.length,
      today: today,
      ordersToday: allOrders.filter(o => new Date(o.createdAt).toDateString() === today).length,
      earningsToday: completedOrders
        .filter(o => o.deliveredAt && new Date(o.deliveredAt).toDateString() === today)
        .reduce((sum, o) => sum + (o.platformEarnings || 0), 0),
      averageOrderValue: completedOrders.length > 0 
        ? completedOrders.reduce((sum, o) => sum + o.total, 0) / completedOrders.length 
        : 0,
      averagePlatformEarningPerOrder: completedOrders.length > 0
        ? completedOrders.reduce((sum, o) => sum + (o.platformEarnings || 0), 0) / completedOrders.length
        : 0
    };

    res.json({ stats });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estadísticas', details: error.message });
  }
});

app.get('/api/admin/drivers/pending', authenticateToken, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const pendingDrivers = database.users
      .filter(u => u.role === 'driver' && u.approved === false)
      .map(({ password, ...driver }) => driver);

    res.json({ drivers: pendingDrivers });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener conductores', details: error.message });
  }
});

app.put('/api/admin/drivers/:driverId/approve', authenticateToken, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { driverId } = req.params;
    const driver = database.users.find(u => u.id === parseInt(driverId) && u.role === 'driver');

    if (!driver) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    driver.approved = true;
    driver.available = true;

    notifyUser(driver.id, {
      title: '¡Cuenta aprobada!',
      message: 'Tu cuenta de conductor ha sido aprobada. Ya puedes comenzar a tomar pedidos.',
      type: 'success',
      timestamp: new Date()
    });

    saveDatabase();
    res.json({
      message: 'Conductor aprobado',
      driver: { id: driver.id, name: driver.name, email: driver.email, approved: true }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al aprobar conductor', details: error.message });
  }
});

app.delete('/api/admin/drivers/:driverId/reject', authenticateToken, (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { driverId } = req.params;
    const driverIndex = database.users.findIndex(u => u.id === parseInt(driverId) && u.role === 'driver');

    if (driverIndex === -1) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    const driver = database.users[driverIndex];

    notifyUser(driver.id, {
      title: 'Solicitud rechazada',
      message: 'Tu solicitud de conductor no ha sido aprobada.',
      type: 'warning',
      timestamp: new Date()
    });

    database.users.splice(driverIndex, 1);
    saveDatabase();
    res.json({ message: 'Conductor rechazado' });
  } catch (error) {
    res.status(500).json({ error: 'Error al rechazar conductor', details: error.message });
  }
});

app.get('/api/stats', authenticateToken, (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    let stats = {};

    if (userRole === 'client') {
      const userOrders = database.orders.filter(o => o.customerId === userId);
      stats = {
        totalOrders: userOrders.length,
        totalSpent: userOrders.reduce((sum, o) => sum + o.total, 0),
        completedOrders: userOrders.filter(o => o.status === 'delivered').length,
        cancelledOrders: userOrders.filter(o => o.status === 'cancelled').length
      };
    } else if (userRole === 'driver') {
      const driver = database.users.find(u => u.id === userId);
      const driverOrders = database.orders.filter(o => o.driverId === userId);
      const completedOrders = driverOrders.filter(o => o.status === 'delivered');
      
      stats = {
        totalDeliveries: driver.totalDeliveries,
        totalEarnings: driver.totalEarnings,
        rating: driver.rating,
        activeOrders: driverOrders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length,
        completedToday: completedOrders.filter(o => {
          const today = new Date().toDateString();
          return o.deliveredAt && new Date(o.deliveredAt).toDateString() === today;
        }).length,
        earningsToday: completedOrders
          .filter(o => {
            const today = new Date().toDateString();
            return o.deliveredAt && new Date(o.deliveredAt).toDateString() === today;
          })
          .reduce((sum, o) => sum + (o.driverEarnings || 0), 0)
      };
    } else if (userRole === 'store_owner') {
      const userStores = database.stores.filter(s => s.ownerId === userId);
      const storeIds = userStores.map(s => s.id);
      const storeOrders = database.orders.filter(o => storeIds.includes(o.storeId));
      const completedOrders = storeOrders.filter(o => o.status === 'delivered');
      
      stats = {
        totalStores: userStores.length,
        totalProducts: database.products.filter(p => storeIds.includes(p.storeId)).length,
        totalOrders: storeOrders.length,
        totalRevenue: completedOrders.reduce((sum, o) => sum + o.subtotal, 0),
        activeOrders: storeOrders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length,
        ordersToday: storeOrders.filter(o => {
          const today = new Date().toDateString();
          return new Date(o.createdAt).toDateString() === today;
        }).length
      };
    }

    res.json({ stats });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estadísticas', details: error.message });
  }
});

// ============================================
// WEBSOCKET
// ============================================

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

  socket.on('update_location', (data) => {
    const { driverId, lat, lng } = data;
    const driver = database.users.find(u => u.id === driverId);
    if (driver) {
      driver.currentLocation = { lat, lng };
      io.emit('driver_location_update', { driverId, location: { lat, lng } });
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

// ============================================
// RUTAS HTML
// ============================================

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
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    uptime: process.uptime(),
    stores: database.stores.length,
    products: database.products.length,
    orders: database.orders.length,
    connectedUsers: userSockets.size
  });
});

// ============================================
// 404 HANDLER
// ============================================

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ============================================
// INICIAR SERVIDOR
// ============================================

server.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 SERVIDOR DE DELIVERY INICIADO`);
  console.log(`${'='.repeat(60)}`);
  console.log(`🌐 Puerto: ${PORT}`);
  console.log(`📡 WebSocket: Habilitado`);
  console.log(`🔔 Notificaciones: Activas`);
  console.log(`💰 Comisión: ${COMMISSION_RATE * 100}% | Fee de servicio: ${SERVICE_FEE}`);
  console.log(`🏪 Tiendas: ${database.stores.length} | 📦 Productos: ${database.products.length}`);
  console.log(`\n📋 FLUJO DE ESTADOS DE PEDIDOS:`);
  console.log(`   1. PENDING    → Cliente crea pedido`);
  console.log(`   2. ACCEPTED   → Tienda acepta`);
  console.log(`   3. PREPARING  → Tienda prepara`);
  console.log(`   4. READY      → Listo para recoger`);
  console.log(`   5. PICKED_UP  → Conductor recoge (SE ASIGNA AQUÍ) 🎯`);
  console.log(`   6. ON_WAY     → En camino al cliente`);
  console.log(`   7. DELIVERED  → ✅ Entregado (SE COBRA AQUÍ) 💰`);
  console.log(`\n👥 USUARIOS DE PRUEBA:`);
  console.log(`   Cliente:    cliente@delivery.com / cliente123`);
  console.log(`   Conductor:  conductor@delivery.com / conductor123`);
  console.log(`   Tienda:     tienda@delivery.com / tienda123`);
  console.log(`   Admin:      admin@delivery.com / admin123`);
  console.log(`\n💡 IMPORTANTE:`);
  console.log(`   - El conductor se asigna automáticamente al confirmar recogida`);
  console.log(`   - Las ganancias se calculan: 70% delivery fee + $5/km`);
  console.log(`   - El pago se registra al marcar como entregado`);
  console.log(`${'='.repeat(60)}\n`);
});

module.exports = { app, server, io };