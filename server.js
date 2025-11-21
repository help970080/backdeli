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

// Notificar a un usuario específico
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

// Notificar a todos los usuarios conectados
function notifyAll(notification) {
  io.emit('notification', notification);
  console.log(`📢 Notificación enviada a TODOS:`, notification.title);
}

// Notificar a todos los usuarios de un rol específico
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

// Notificar a múltiples usuarios específicos
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
      totalDeliveries: 150,
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
      schedule: {
        monday: { open: '09:00', close: '22:00' },
        tuesday: { open: '09:00', close: '22:00' },
        wednesday: { open: '09:00', close: '22:00' },
        thursday: { open: '09:00', close: '22:00' },
        friday: { open: '09:00', close: '23:00' },
        saturday: { open: '10:00', close: '23:00' },
        sunday: { open: '10:00', close: '21:00' }
      },
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
      console.log(`   👥 Usuarios: ${database.users.length}`);
      console.log(`   🏪 Tiendas: ${database.stores.length}`);
      console.log(`   📦 Productos: ${database.products.length}`);
      console.log(`   📋 Pedidos: ${database.orders.length}`);
    } else {
      console.log('📝 Usando base de datos inicial');
      saveDatabase();
    }
  } catch (error) {
    console.error('❌ Error cargando base de datos:', error);
    console.log('📝 Usando base de datos inicial');
  }
}

// Cargar base de datos al iniciar
loadDatabase();

// Guardar automáticamente cada 5 minutos
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
    const { email, password, name, phone, role, vehicle, license, address } = req.body;

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

    // Notificar al admin si es un conductor nuevo
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

    res.json({ store });
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

    // Notificar a todos los clientes de nueva tienda
    notifyRole('client', {
      title: '¡Nueva tienda disponible!',
      message: `${name} ahora está en la plataforma`,
      type: 'success',
      timestamp: new Date()
    });

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
    const total = subtotal + deliveryFee;
    const commission = subtotal * COMMISSION_RATE;

    const newOrder = {
      id: database.orders.length + 1,
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
      createdAt: new Date(),
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

    // 🔔 NOTIFICACIONES: Nuevo pedido
    // Notificar al dueño de la tienda
    notifyUser(store.ownerId, {
      title: '¡Nuevo pedido!',
      message: `Pedido #${newOrder.id} - $${total.toFixed(2)}`,
      type: 'success',
      orderId: newOrder.id,
      timestamp: new Date()
    });

    // Notificar al admin
    notifyRole('admin', {
      title: 'Nuevo pedido en plataforma',
      message: `Pedido #${newOrder.id} en ${store.name}`,
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
      orders = database.orders.filter(o => o.driverId === req.user.id || o.status === ORDER_STATES.READY);
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

    // Actualizar campos específicos según el estado
    if (status === ORDER_STATES.PICKED_UP) {
      order.pickedUpAt = new Date();
    } else if (status === ORDER_STATES.DELIVERED) {
      order.deliveredAt = new Date();
      
      const driver = database.users.find(u => u.id === order.driverId);
      if (driver) {
        driver.totalDeliveries += 1;
        driver.totalEarnings += order.driverEarnings;
      }

      order.platformEarnings = order.commission + order.serviceFee;
    } else if (status === ORDER_STATES.ACCEPTED) {
      order.acceptedAt = new Date();
    } else if (status === ORDER_STATES.READY) {
      order.readyAt = new Date();
    }

    // 🔔 NOTIFICACIONES: Cambio de estado
    const store = database.stores.find(s => s.id === order.storeId);
    const customer = database.users.find(u => u.id === order.customerId);
    
    // Notificar al cliente siempre
    notifyUser(order.customerId, {
      title: 'Actualización de pedido',
      message: getStatusMessage(status, order),
      type: 'info',
      orderId: order.id,
      status: status,
      timestamp: new Date()
    });

    // Notificaciones específicas por estado
    if (status === ORDER_STATES.ACCEPTED) {
      // Notificar al admin
      notifyRole('admin', {
        title: 'Pedido aceptado',
        message: `Pedido #${order.id} aceptado por ${store.name}`,
        type: 'info',
        orderId: order.id,
        timestamp: new Date()
      });
    } 
    else if (status === ORDER_STATES.READY) {
      // Notificar a todos los conductores disponibles
      notifyRole('driver', {
        title: '¡Nuevo pedido disponible!',
        message: `Pedido #${order.id} listo para recoger en ${store.name}`,
        type: 'success',
        orderId: order.id,
        timestamp: new Date()
      });
      
      // Notificar al admin
      notifyRole('admin', {
        title: 'Pedido listo',
        message: `Pedido #${order.id} listo para entrega`,
        type: 'info',
        orderId: order.id,
        timestamp: new Date()
      });
    }
    else if (status === ORDER_STATES.PICKED_UP) {
      // Notificar a la tienda
      if (store) {
        notifyUser(store.ownerId, {
          title: 'Pedido recogido',
          message: `Pedido #${order.id} recogido por el conductor`,
          type: 'info',
          orderId: order.id,
          timestamp: new Date()
        });
      }
    }
    else if (status === ORDER_STATES.DELIVERED) {
      // Notificar a la tienda
      if (store) {
        notifyUser(store.ownerId, {
          title: 'Pedido entregado',
          message: `Pedido #${order.id} entregado exitosamente`,
          type: 'success',
          orderId: order.id,
          timestamp: new Date()
        });
      }

      // Notificar al conductor
      if (order.driverId) {
        notifyUser(order.driverId, {
          title: 'Entrega completada',
          message: `Ganaste $${order.driverEarnings.toFixed(2)} por esta entrega`,
          type: 'success',
          orderId: order.id,
          timestamp: new Date()
        });
      }

      // Notificar al admin
      notifyRole('admin', {
        title: 'Pedido completado',
        message: `Pedido #${order.id} entregado - Ganancia: $${order.platformEarnings.toFixed(2)}`,
        type: 'success',
        orderId: order.id,
        timestamp: new Date()
      });
    }
    else if (status === ORDER_STATES.CANCELLED) {
      // Notificar a todos los involucrados
      const usersToNotify = [order.customerId];
      if (store) usersToNotify.push(store.ownerId);
      if (order.driverId) usersToNotify.push(order.driverId);

      notifyMultiple(usersToNotify, {
        title: 'Pedido cancelado',
        message: `El pedido #${order.id} ha sido cancelado`,
        type: 'warning',
        orderId: order.id,
        timestamp: new Date()
      });

      // Notificar al admin
      notifyRole('admin', {
        title: 'Pedido cancelado',
        message: `Pedido #${order.id} cancelado en estado ${oldStatus}`,
        type: 'warning',
        orderId: order.id,
        timestamp: new Date()
      });
    }

    saveDatabase();
    res.json({ 
      message: 'Estado actualizado exitosamente',
      order 
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar estado', details: error.message });
  }
});

// Función auxiliar para mensajes de estado
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

    // 🔔 NOTIFICACIONES: Conductor asignado
    const store = database.stores.find(s => s.id === order.storeId);

    // Notificar al cliente
    notifyUser(order.customerId, {
      title: 'Conductor asignado',
      message: `${driver.name} recogerá tu pedido`,
      type: 'info',
      orderId: order.id,
      timestamp: new Date()
    });

    // Notificar a la tienda
    if (store) {
      notifyUser(store.ownerId, {
        title: 'Conductor asignado',
        message: `${driver.name} recogerá el pedido #${order.id}`,
        type: 'info',
        orderId: order.id,
        timestamp: new Date()
      });
    }

    // Notificar al admin
    notifyRole('admin', {
      title: 'Pedido asignado',
      message: `Pedido #${order.id} asignado a ${driver.name}`,
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

    // 🔔 NOTIFICACIÓN: Conductor aprobado
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

    // 🔔 NOTIFICACIÓN: Conductor rechazado
    notifyUser(driver.id, {
      title: 'Solicitud rechazada',
      message: 'Tu solicitud de conductor no ha sido aprobada. Contacta con soporte para más información.',
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
// WEBSOCKET - CONSOLIDADO
// ============================================

io.on('connection', (socket) => {
  console.log('🔌 Cliente conectado:', socket.id);

  // Registrar usuario conectado
  socket.on('register', (data) => {
    const { userId } = data;
    userSockets.set(userId.toString(), socket.id);
    console.log(`✅ Usuario ${userId} registrado con socket ${socket.id}`);
  });

  // Suscripción por rol
  socket.on('subscribe', (data) => {
    const { userId, role } = data;
    socket.join(`${role}:${userId}`);
    userSockets.set(userId.toString(), socket.id);
    console.log(`📡 Usuario ${userId} (${role}) suscrito`);
  });

  // Actualización de ubicación del conductor
  socket.on('update_location', (data) => {
    const { driverId, lat, lng } = data;
    const driver = database.users.find(u => u.id === driverId);
    if (driver) {
      driver.currentLocation = { lat, lng };
      io.emit('driver_location_update', { driverId, location: { lat, lng } });
    }
  });

  // Desconexión
  socket.on('disconnect', () => {
    // Eliminar del mapa de usuarios conectados
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
// HEALTH CHECK Y 404
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
  console.log(`📍 Puerto: ${PORT}`);
  console.log(`📡 WebSocket: Habilitado`);
  console.log(`🔔 Notificaciones: Activas`);
  console.log(`💰 Comisión: ${COMMISSION_RATE * 100}% | Fee de servicio: $${SERVICE_FEE}`);
  console.log(`🏪 Tiendas: ${database.stores.length} | 📦 Productos: ${database.products.length}`);
  console.log(`\n📋 FLUJO DE ESTADOS DE PEDIDOS:`);
  console.log(`   1. PENDING    → Cliente crea pedido`);
  console.log(`   2. ACCEPTED   → Tienda acepta`);
  console.log(`   3. PREPARING  → Tienda prepara`);
  console.log(`   4. READY      → Listo para recoger`);
  console.log(`   5. PICKED_UP  → Conductor recoge`);
  console.log(`   6. ON_WAY     → En camino al cliente`);
  console.log(`   7. DELIVERED  → ✅ Entregado`);
  console.log(`\n🌐 RUTAS DISPONIBLES:`);
  console.log(`   GET  /health              → Estado del servidor`);
  console.log(`   POST /api/auth/register   → Registro de usuarios`);
  console.log(`   POST /api/auth/login      → Inicio de sesión`);
  console.log(`   GET  /api/stores          → Listar tiendas`);
  console.log(`   GET  /api/orders          → Listar pedidos`);
  console.log(`   POST /api/orders          → Crear pedido`);
  console.log(`\n👥 USUARIOS DE PRUEBA:`);
  console.log(`   Cliente:    cliente@delivery.com / cliente123`);
  console.log(`   Conductor:  conductor@delivery.com / conductor123`);
  console.log(`   Tienda:     tienda@delivery.com / tienda123`);
  console.log(`   Admin:      admin@delivery.com / admin123`);
  console.log(`${'='.repeat(60)}\n`);
});

module.exports = { app, server, io };