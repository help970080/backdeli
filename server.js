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
const JWT_SECRET = 'tu-secreto-super-seguro';
const PORT = process.env.PORT || 3000;
const COMMISSION_RATE = 0.20;
const SERVICE_FEE = 10;

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
      location: { lat: 19.4320, lng: -99.1325, address: 'Av. Japón 789' },
      createdAt: new Date()
    }
  ],
  
  products: [
    { id: 1, storeId: 1, name: 'Tacos de Pastor', description: 'Con piña y cilantro', price: 45, image: '/uploads/products/pastor.jpg', category: 'Tacos', available: true },
    { id: 2, storeId: 1, name: 'Tacos de Asada', description: 'Carne asada premium', price: 50, image: '/uploads/products/asada.jpg', category: 'Tacos', available: true },
    { id: 3, storeId: 1, name: 'Quesadillas', description: 'Con queso Oaxaca', price: 40, image: '/uploads/products/quesadilla.jpg', category: 'Antojitos', available: true },
    { id: 4, storeId: 1, name: 'Torta de Pastor', description: 'Pan telera con todo', price: 55, image: '/uploads/products/torta.jpg', category: 'Tortas', available: true },
    { id: 5, storeId: 2, name: 'Pizza Margarita', description: 'Tomate, mozzarella, albahaca', price: 150, image: '/uploads/products/margarita.jpg', category: 'Pizzas', available: true },
    { id: 6, storeId: 2, name: 'Pizza Pepperoni', description: 'Doble pepperoni', price: 170, image: '/uploads/products/pepperoni.jpg', category: 'Pizzas', available: true },
    { id: 7, storeId: 2, name: 'Lasagna', description: 'Casera con bechamel', price: 130, image: '/uploads/products/lasagna.jpg', category: 'Pastas', available: true },
    { id: 8, storeId: 3, name: 'Roll California', description: '8 piezas con aguacate', price: 120, image: '/uploads/products/california.jpg', category: 'Rolls', available: true },
    { id: 9, storeId: 3, name: 'Roll Philadelphia', description: '8 piezas con queso crema', price: 140, image: '/uploads/products/philadelphia.jpg', category: 'Rolls', available: true },
    { id: 10, storeId: 3, name: 'Sashimi Mix', description: '12 cortes variados', price: 180, image: '/uploads/products/sashimi.jpg', category: 'Sashimi', available: true }
  ],
  
  storeCategories: [
    'Mexicana', 'Italiana', 'Japonesa', 'China', 'Hamburguesas', 
    'Pizza', 'Ensaladas', 'Postres', 'Café', 'Mariscos'
  ],
  
  orders: [],
  orderCounter: 1,
  userCounter: 5,
  storeCounter: 4,
  productCounter: 11
};

// Utilidades
const generateOrderId = () => {
  return `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`.toUpperCase();
};

const calculateDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

const calculateDeliveryFee = (distance) => {
  const baseFee = 30;
  const perKmFee = 8;
  return baseFee + (distance * perKmFee);
};

const estimateDeliveryTime = (distance) => {
  const avgSpeed = 25;
  const minutes = (distance / avgSpeed) * 60;
  return Math.ceil(minutes);
};

// Middleware de autenticación
const authenticateToken = (req, res, next) => {
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
};

// ============================================
// RUTAS FRONTEND
// ============================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/cliente', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cliente.html'));
});

app.get('/conductor', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'conductor.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/tienda', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tienda.html'));
});

// ============================================
// UPLOAD DE IMÁGENES
// ============================================

app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se subió ningún archivo' });
    }
    
    res.json({ 
      message: 'Archivo subido exitosamente',
      filename: req.file.filename,
      url: `/uploads/${req.file.filename}`
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al subir archivo', details: error.message });
  }
});

// ============================================
// AUTENTICACIÓN
// ============================================

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    const user = database.users.find(u => u.email === email);
    
    if (!user || password !== user.password) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    if (user.role === 'driver' && user.approved === false) {
      return res.status(403).json({ error: 'Tu cuenta está pendiente de aprobación' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET);
    const { password: _, ...userWithoutPassword } = user;

    res.json({ message: 'Login exitoso', token, user: userWithoutPassword });
  } catch (error) {
    res.status(500).json({ error: 'Error al iniciar sesión', details: error.message });
  }
});

app.post('/api/auth/register', (req, res) => {
  try {
    const { email, password, name, phone, role, address, vehicle, license, inePhoto, vehiclePhoto } = req.body;

    if (!email || !password || !name || !phone || !role) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    if (database.users.find(u => u.email === email)) {
      return res.status(409).json({ error: 'El email ya está registrado' });
    }

    if (!['client', 'driver', 'store_owner'].includes(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }

    if (role === 'driver' && (!vehicle || !license || !inePhoto || !vehiclePhoto)) {
      return res.status(400).json({ error: 'Conductores deben proporcionar toda la información requerida' });
    }

    const newUser = {
      id: database.userCounter++,
      email,
      password,
      name,
      phone,
      role,
      createdAt: new Date()
    };

    if (role === 'client') {
      newUser.address = address || '';
    }

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
    }

    database.users.push(newUser);

    if (role === 'client' || role === 'store_owner') {
      const token = jwt.sign({ id: newUser.id, email: newUser.email, role: newUser.role }, JWT_SECRET);
      const { password: _, ...userWithoutPassword } = newUser;
      
      return res.status(201).json({
        message: 'Registro exitoso',
        token,
        user: userWithoutPassword
      });
    }

    res.status(201).json({
      message: 'Registro exitoso. Tu cuenta será revisada y aprobada pronto.',
      pendingApproval: true
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al registrar usuario', details: error.message });
  }
});

// ============================================
// RUTAS DE TIENDAS
// ============================================

app.get('/api/stores', (req, res) => {
  try {
    const { category, search, isOpen } = req.query;
    let stores = [...database.stores];

    if (category && category !== 'all') {
      stores = stores.filter(s => s.category === category);
    }

    if (search) {
      const searchLower = search.toLowerCase();
      stores = stores.filter(s => 
        s.name.toLowerCase().includes(searchLower) ||
        s.description.toLowerCase().includes(searchLower)
      );
    }

    if (isOpen === 'true') {
      stores = stores.filter(s => s.isOpen);
    }

    res.json({ 
      stores,
      total: stores.length,
      categories: database.storeCategories
    });
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

    const products = database.products.filter(p => p.storeId === store.id && p.available);

    res.json({ 
      store,
      products,
      totalProducts: products.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener tienda', details: error.message });
  }
});

app.post('/api/stores', authenticateToken, upload.single('image'), (req, res) => {
  try {
    if (!['admin', 'store_owner'].includes(req.user.role)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { name, description, category, deliveryTime, deliveryFee, minOrder, location } = req.body;

    if (!name || !category) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const newStore = {
      id: database.storeCounter++,
      name,
      description: description || '',
      category,
      image: req.file ? `/uploads/stores/${req.file.filename}` : '/uploads/stores/default.jpg',
      rating: 5.0,
      deliveryTime: deliveryTime || '30-40 min',
      deliveryFee: parseFloat(deliveryFee) || 35,
      minOrder: parseFloat(minOrder) || 50,
      isOpen: true,
      ownerId: req.user.id,
      location: location ? JSON.parse(location) : { lat: 19.4326, lng: -99.1332, address: 'Por definir' },
      createdAt: new Date()
    };

    database.stores.push(newStore);

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

    if (req.user.role !== 'admin' && store.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { name, description, category, deliveryTime, deliveryFee, minOrder, isOpen } = req.body;

    if (name) store.name = name;
    if (description) store.description = description;
    if (category) store.category = category;
    if (deliveryTime) store.deliveryTime = deliveryTime;
    if (deliveryFee) store.deliveryFee = parseFloat(deliveryFee);
    if (minOrder) store.minOrder = parseFloat(minOrder);
    if (isOpen !== undefined) store.isOpen = isOpen === 'true' || isOpen === true;
    if (req.file) store.image = `/uploads/stores/${req.file.filename}`;

    res.json({
      message: 'Tienda actualizada exitosamente',
      store
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar tienda', details: error.message });
  }
});

// ============================================
// RUTAS DE PRODUCTOS
// ============================================

app.get('/api/stores/:storeId/products', (req, res) => {
  try {
    const { storeId } = req.params;
    const { category } = req.query;

    let products = database.products.filter(p => p.storeId === parseInt(storeId));

    if (category && category !== 'all') {
      products = products.filter(p => p.category === category);
    }

    const categoriesSet = new Set(products.map(p => p.category));
    const categories = Array.from(categoriesSet);

    res.json({
      products,
      categories,
      total: products.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener productos', details: error.message });
  }
});

app.post('/api/products', authenticateToken, upload.single('image'), (req, res) => {
  try {
    const { storeId, name, description, price, category } = req.body;

    const store = database.stores.find(s => s.id === parseInt(storeId));
    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    if (req.user.role !== 'admin' && store.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    if (!name || !price) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const newProduct = {
      id: database.productCounter++,
      storeId: parseInt(storeId),
      name,
      description: description || '',
      price: parseFloat(price),
      image: req.file ? `/uploads/products/${req.file.filename}` : '/uploads/products/default.jpg',
      category: category || 'General',
      available: true,
      createdAt: new Date()
    };

    database.products.push(newProduct);

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
    if (req.user.role !== 'admin' && store.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { name, description, price, category, available } = req.body;

    if (name) product.name = name;
    if (description) product.description = description;
    if (price) product.price = parseFloat(price);
    if (category) product.category = category;
    if (available !== undefined) product.available = available === 'true' || available === true;
    if (req.file) product.image = `/uploads/products/${req.file.filename}`;

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

    if (req.user.role !== 'admin' && store.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    database.products.splice(productIndex, 1);

    res.json({ message: 'Producto eliminado exitosamente' });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar producto', details: error.message });
  }
});

// ============================================
// RUTAS DE PEDIDOS (CON FLUJO CORREGIDO)
// ============================================

app.post('/api/orders', authenticateToken, (req, res) => {
  try {
    const { storeId, items, deliveryAddress, paymentMethod, notes } = req.body;
    const userId = req.user.id;

    if (!storeId) {
      return res.status(400).json({ error: 'Debe especificar una tienda' });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'El pedido debe tener al menos un item' });
    }

    const store = database.stores.find(s => s.id === parseInt(storeId));
    if (!store) {
      return res.status(404).json({ error: 'Tienda no encontrada' });
    }

    if (!store.isOpen) {
      return res.status(400).json({ error: 'La tienda está cerrada' });
    }

    let subtotal = 0;
    const orderItems = items.map(item => {
      const product = database.products.find(p => p.id === item.productId);
      if (!product || !product.available) {
        throw new Error(`Producto no disponible: ${item.productId}`);
      }
      subtotal += product.price * item.quantity;
      return {
        productId: product.id,
        name: product.name,
        price: product.price,
        quantity: item.quantity,
        notes: item.notes || ''
      };
    });

    if (subtotal < store.minOrder) {
      return res.status(400).json({ 
        error: `El pedido mínimo es de ${store.minOrder}`,
        minOrder: store.minOrder,
        currentTotal: subtotal
      });
    }

    const availableDrivers = database.users.filter(u => 
      u.role === 'driver' && u.available && u.approved && u.currentLocation
    );

    if (availableDrivers.length === 0) {
      return res.status(404).json({ error: 'No hay conductores disponibles' });
    }

    let nearestDriver = availableDrivers[0];
    let minDistance = calculateDistance(
      store.location.lat,
      store.location.lng,
      nearestDriver.currentLocation.lat,
      nearestDriver.currentLocation.lng
    );

    availableDrivers.forEach(driver => {
      const distance = calculateDistance(
        store.location.lat,
        store.location.lng,
        driver.currentLocation.lat,
        driver.currentLocation.lng
      );
      if (distance < minDistance) {
        minDistance = distance;
        nearestDriver = driver;
      }
    });

    const deliveryFee = store.deliveryFee || calculateDeliveryFee(minDistance);
    const serviceFee = SERVICE_FEE;
    const commission = deliveryFee * COMMISSION_RATE;
    const driverEarnings = deliveryFee - commission;
    const platformEarnings = commission + serviceFee;
    const total = subtotal + deliveryFee + serviceFee;
    const estimatedTime = estimateDeliveryTime(minDistance);

    const newOrder = {
      id: generateOrderId(),
      orderNumber: database.orderCounter++,
      customerId: userId,
      customer: database.users.find(u => u.id === userId),
      driverId: nearestDriver.id,
      driver: nearestDriver,
      storeId: store.id,
      store: {
        id: store.id,
        name: store.name,
        image: store.image,
        location: store.location
      },
      items: orderItems,
      deliveryAddress,
      paymentMethod: paymentMethod || 'cash',
      notes: notes || '',
      status: 'pending',
      subtotal,
      deliveryFee,
      serviceFee,
      commission,
      driverEarnings,
      platformEarnings,
      total,
      distance: minDistance,
      estimatedTime,
      statusHistory: [
        { 
          status: 'pending', 
          timestamp: new Date(), 
          note: 'Pedido creado, esperando aceptación de tienda',
          updatedBy: userId,
          updatedByRole: 'client'
        }
      ],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    database.orders.push(newOrder);

    // Notificar a la tienda
    if (store.ownerId) {
      io.emit(`store:${store.ownerId}`, {
        type: 'new_order',
        message: '🔔 Nuevo pedido recibido',
        order: newOrder,
        sound: 'notification'
      });
    }

    // Notificar al conductor (informativo, no puede hacer nada aún)
    io.emit(`driver:${nearestDriver.id}`, {
      type: 'new_order_assigned',
      message: 'Se te asignó un pedido. Esperando aceptación de tienda.',
      order: newOrder
    });

    res.status(201).json({
      message: 'Pedido creado exitosamente',
      order: newOrder
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al crear pedido', details: error.message });
  }
});

// ============================================
// ACTUALIZAR ESTADO DE PEDIDO (LÓGICA CORREGIDA)
// ============================================

app.put('/api/orders/:orderId/status', authenticateToken, (req, res) => {
  try {
    const { orderId } = req.params;
    const { status, note } = req.body;
    const userId = req.user.id;
    const userRole = req.user.role;

    const order = database.orders.find(o => o.id === orderId);
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // VALIDACIÓN DE PERMISOS POR ROL
    if (userRole === 'client') {
      if (status !== 'cancelled' || order.status !== 'pending') {
        return res.status(403).json({ error: 'Solo puedes cancelar pedidos pendientes.' });
      }
      if (order.customerId !== userId) {
        return res.status(403).json({ error: 'Este no es tu pedido' });
      }
    } else if (userRole === 'store_owner') {
      const store = database.stores.find(s => s.id === order.storeId);
      if (!store || store.ownerId !== userId) {
        return res.status(403).json({ error: 'No eres el dueño de esta tienda' });
      }
      
      const allowedStates = ['pending', 'accepted', 'preparing'];
      if (!allowedStates.includes(order.status)) {
        return res.status(403).json({ 
          error: `No puedes modificar el pedido en estado "${order.status}". El conductor está encargado de la entrega.`,
          currentStatus: order.status
        });
      }
      
      if (order.status === 'pending' && status !== 'accepted' && status !== 'cancelled') {
        return res.status(400).json({ error: 'Debes aceptar o cancelar el pedido' });
      }
      if (order.status === 'accepted' && status !== 'preparing' && status !== 'cancelled') {
        return res.status(400).json({ error: 'Debes comenzar la preparación' });
      }
      if (order.status === 'preparing' && status !== 'ready' && status !== 'cancelled') {
        return res.status(400).json({ error: 'Debes marcar el pedido como listo' });
      }
      
    } else if (userRole === 'driver') {
      if (order.driverId !== userId) {
        return res.status(403).json({ error: 'No eres el conductor asignado' });
      }
      
      const allowedStates = ['ready', 'picked_up', 'on_way'];
      if (!allowedStates.includes(order.status)) {
        return res.status(403).json({ 
          error: `No puedes modificar el pedido en estado "${order.status}". Espera a que la tienda lo prepare.`,
          currentStatus: order.status
        });
      }
      
      if (order.status === 'ready' && status !== 'picked_up') {
        return res.status(400).json({ error: 'Debes confirmar que recogiste el pedido' });
      }
      if (order.status === 'picked_up' && status !== 'on_way') {
        return res.status(400).json({ error: 'Debes marcar que estás en camino' });
      }
      if (order.status === 'on_way' && status !== 'delivered') {
        return res.status(400).json({ error: 'Debes marcar el pedido como entregado' });
      }
    }

    const validStatuses = Object.values(ORDER_STATES);
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    const currentStatePermissions = STATE_PERMISSIONS[order.status];
    if (!currentStatePermissions.nextStates.includes(status)) {
      return res.status(400).json({ 
        error: 'Transición de estado inválida',
        currentStatus: order.status,
        requestedStatus: status,
        allowedNextStates: currentStatePermissions.nextStates
      });
    }

    // ACTUALIZAR ESTADO
    const previousStatus = order.status;
    order.status = status;
    order.updatedAt = new Date();
    order.statusHistory.push({
      status,
      previousStatus,
      timestamp: new Date(),
      note: note || '',
      updatedBy: userId,
      updatedByRole: userRole
    });

    // ACCIONES POR ESTADO
    if (status === 'accepted') {
      order.acceptedAt = new Date();
      order.acceptedBy = userId;
      
      io.emit(`client:${order.customerId}`, {
        type: 'order_accepted',
        message: '✓ Tu pedido fue aceptado por la tienda',
        order: order
      });
      
      io.emit(`driver:${order.driverId}`, {
        type: 'order_accepted',
        message: 'Tienda aceptó el pedido. Esperando preparación.',
        order: order
      });
    }

    if (status === 'preparing') {
      order.preparingAt = new Date();
      
      io.emit(`client:${order.customerId}`, {
        type: 'order_preparing',
        message: '👨‍🍳 Tu pedido está siendo preparado',
        order: order
      });
      
      io.emit(`driver:${order.driverId}`, {
        type: 'order_preparing',
        message: 'La tienda está preparando el pedido.',
        order: order
      });
    }

    if (status === 'ready') {
      order.readyAt = new Date();
      
      io.emit(`driver:${order.driverId}`, {
        type: 'order_ready',
        message: '📦 Pedido listo para recoger en ' + order.store.name,
        order: order,
        sound: 'notification',
        priority: 'high'
      });
      
      io.emit(`client:${order.customerId}`, {
        type: 'order_ready',
        message: '📦 Tu pedido está listo, esperando al conductor',
        order: order
      });
    }

    if (status === 'picked_up') {
      order.pickedUpAt = new Date();
      
      const driver = database.users.find(u => u.id === order.driverId);
      if (driver) {
        driver.available = false;
      }
      
      io.emit(`client:${order.customerId}`, {
        type: 'order_picked_up',
        message: `🚗 ${driver?.name} recogió tu pedido`,
        order: order
      });
      
      const store = database.stores.find(s => s.id === order.storeId);
      if (store && store.ownerId) {
        io.emit(`store:${store.ownerId}`, {
          type: 'order_picked_up',
          message: 'Conductor recogió el pedido #' + order.orderNumber,
          order: order
        });
      }
    }

    if (status === 'on_way') {
      order.onWayAt = new Date();
      
      io.emit(`client:${order.customerId}`, {
        type: 'order_on_way',
        message: '🛵 Tu pedido está en camino',
        order: order
      });
    }

    if (status === 'delivered') {
      order.deliveredAt = new Date();
      
      const driver = database.users.find(u => u.id === order.driverId);
      if (driver) {
        driver.totalDeliveries += 1;
        driver.totalEarnings += order.driverEarnings;
        driver.available = true;
      }
      
      io.emit(`client:${order.customerId}`, {
        type: 'order_delivered',
        message: '✅ ¡Tu pedido ha sido entregado! ¡Buen provecho!',
        order: order
      });
      
      const store = database.stores.find(s => s.id === order.storeId);
      if (store && store.ownerId) {
        io.emit(`store:${store.ownerId}`, {
          type: 'order_delivered',
          message: 'Pedido #' + order.orderNumber + ' entregado',
          order: order
        });
      }
    }

    if (status === 'cancelled') {
      order.cancelledAt = new Date();
      order.cancelledBy = userId;
      order.cancelledReason = note || 'Sin razón';
      
      if (['picked_up', 'on_way'].includes(previousStatus)) {
        const driver = database.users.find(u => u.id === order.driverId);
        if (driver) {
          driver.available = true;
        }
      }
      
      io.emit(`client:${order.customerId}`, {
        type: 'order_cancelled',
        message: '❌ Pedido cancelado: ' + order.cancelledReason,
        order: order
      });
      
      if (order.driverId) {
        io.emit(`driver:${order.driverId}`, {
          type: 'order_cancelled',
          message: 'Pedido #' + order.orderNumber + ' cancelado',
          order: order
        });
      }
      
      const store = database.stores.find(s => s.id === order.storeId);
      if (store && store.ownerId && userId !== store.ownerId) {
        io.emit(`store:${store.ownerId}`, {
          type: 'order_cancelled',
          message: 'Pedido #' + order.orderNumber + ' cancelado',
          order: order
        });
      }
    }

    res.json({
      success: true,
      message: 'Estado actualizado exitosamente',
      order: order,
      previousStatus: previousStatus,
      newStatus: status
    });
    
  } catch (error) {
    console.error('Error al actualizar estado:', error);
    res.status(500).json({ error: 'Error al actualizar estado', details: error.message });
  }
});

app.get('/api/orders', authenticateToken, (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let orders;
    if (userRole === 'client') {
      orders = database.orders.filter(o => o.customerId === userId);
    } else if (userRole === 'driver') {
      orders = database.orders.filter(o => o.driverId === userId);
    } else if (userRole === 'store_owner') {
      const userStores = database.stores.filter(s => s.ownerId === userId).map(s => s.id);
      orders = database.orders.filter(o => userStores.includes(o.storeId));
    } else {
      orders = database.orders;
    }

    orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ orders, total: orders.length });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener pedidos', details: error.message });
  }
});

app.get('/api/orders/:orderId', authenticateToken, (req, res) => {
  try {
    const { orderId } = req.params;
    const order = database.orders.find(o => o.id === orderId);

    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const userId = req.user.id;
    const userRole = req.user.role;

    if (userRole !== 'admin' && order.customerId !== userId && order.driverId !== userId) {
      const store = database.stores.find(s => s.id === order.storeId);
      if (!store || store.ownerId !== userId) {
        return res.status(403).json({ error: 'No autorizado' });
      }
    }

    res.json({ order });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener pedido', details: error.message });
  }
});

// ============================================
// USUARIO
// ============================================

app.get('/api/users/profile', authenticateToken, (req, res) => {
  try {
    const user = database.users.find(u => u.id === req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const { password, ...userWithoutPassword } = user;
    res.json({ user: userWithoutPassword });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener perfil', details: error.message });
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

    database.users.splice(driverIndex, 1);
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
  console.log('Cliente conectado:', socket.id);

  socket.on('subscribe', (data) => {
    const { userId, role } = data;
    socket.join(`${role}:${userId}`);
    console.log(`Usuario ${userId} (${role}) suscrito`);
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
    console.log('Cliente desconectado:', socket.id);
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
    orders: database.orders.length
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ============================================
// INICIAR SERVIDOR
// ============================================

server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📡 WebSocket habilitado`);
  console.log(`💰 Comisión: ${COMMISSION_RATE * 100}% | Fee: ${SERVICE_FEE}`);
  console.log(`🏪 Tiendas: ${database.stores.length} | Productos: ${database.products.length}`);
  console.log(`📋 Estados de pedidos:`);
  console.log(`   1. PENDING → TIENDA acepta`);
  console.log(`   2. ACCEPTED → TIENDA prepara`);
  console.log(`   3. PREPARING → TIENDA marca listo`);
  console.log(`   4. READY → CONDUCTOR recoge`);
  console.log(`   5. PICKED_UP → CONDUCTOR en camino`);
  console.log(`   6. ON_WAY → CONDUCTOR entrega`);
  console.log(`   7. DELIVERED → ✅ Completado`);
  console.log(`\n🌐 URLs disponibles:`);
  console.log(`   / → Login`);
  console.log(`   /cliente → Panel Cliente`);
  console.log(`   /conductor → Panel Conductor`);
  console.log(`   /admin → Panel Admin`);
  console.log(`   /tienda → Panel Tienda`);
});

module.exports = { app, server, io };