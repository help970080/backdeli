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

// Crear carpeta uploads si no existe
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configuración de multer para subir archivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
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
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB max
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
    }
  ],
  orders: [],
  orderCounter: 1,
  userCounter: 4
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

// ============================================
// ENDPOINT DE UPLOAD DE IMÁGENES
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
// RUTAS DE AUTENTICACIÓN
// ============================================

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;

    const user = database.users.find(u => u.email === email);
    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    if (password !== user.password) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Verificar si es conductor pendiente
    if (user.role === 'driver' && user.approved === false) {
      return res.status(403).json({ error: 'Tu cuenta está pendiente de aprobación' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET);
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

app.post('/api/auth/register', (req, res) => {
  try {
    const { email, password, name, phone, role, address, vehicle, license, inePhoto, vehiclePhoto } = req.body;

    // Validaciones básicas
    if (!email || !password || !name || !phone || !role) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    // Verificar si el email ya existe
    if (database.users.find(u => u.email === email)) {
      return res.status(409).json({ error: 'El email ya está registrado' });
    }

    // Solo permitir registro de clientes y conductores
    if (!['client', 'driver'].includes(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }

    // Validaciones específicas para conductores
    if (role === 'driver') {
      if (!vehicle || !license) {
        return res.status(400).json({ error: 'Conductores deben proporcionar vehículo y licencia' });
      }
      if (!inePhoto || !vehiclePhoto) {
        return res.status(400).json({ error: 'Conductores deben subir foto de INE y vehículo' });
      }
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
      newUser.approved = false; // Requiere aprobación
      newUser.currentLocation = { lat: 19.4326, lng: -99.1332 };
      newUser.rating = 5.0;
      newUser.totalDeliveries = 0;
      newUser.totalEarnings = 0;
    }

    database.users.push(newUser);

    // Si es cliente, auto-login
    if (role === 'client') {
      const token = jwt.sign({ id: newUser.id, email: newUser.email, role: newUser.role }, JWT_SECRET);
      const { password: _, ...userWithoutPassword } = newUser;
      
      return res.status(201).json({
        message: 'Registro exitoso',
        token,
        user: userWithoutPassword
      });
    }

    // Si es conductor, no dar token (debe esperar aprobación)
    res.status(201).json({
      message: 'Registro exitoso. Tu cuenta será revisada y aprobada pronto.',
      pendingApproval: true
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al registrar usuario', details: error.message });
  }
});

// ============================================
// RUTAS DE PEDIDOS
// ============================================

app.post('/api/orders', authenticateToken, (req, res) => {
  try {
    const { items, deliveryAddress, paymentMethod, notes } = req.body;
    const userId = req.user.id;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'El pedido debe tener al menos un item' });
    }

    if (!deliveryAddress || !deliveryAddress.lat || !deliveryAddress.lng) {
      return res.status(400).json({ error: 'Dirección de entrega inválida' });
    }

    const availableDrivers = database.users.filter(u => 
      u.role === 'driver' && 
      u.available && 
      u.approved &&
      u.currentLocation
    );

    if (availableDrivers.length === 0) {
      return res.status(404).json({ error: 'No hay conductores disponibles' });
    }

    let nearestDriver = availableDrivers[0];
    let minDistance = calculateDistance(
      deliveryAddress.lat,
      deliveryAddress.lng,
      nearestDriver.currentLocation.lat,
      nearestDriver.currentLocation.lng
    );

    availableDrivers.forEach(driver => {
      const distance = calculateDistance(
        deliveryAddress.lat,
        deliveryAddress.lng,
        driver.currentLocation.lat,
        driver.currentLocation.lng
      );
      if (distance < minDistance) {
        minDistance = distance;
        nearestDriver = driver;
      }
    });

    const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const deliveryFee = calculateDeliveryFee(minDistance);
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
      items,
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
        { status: 'pending', timestamp: new Date(), note: 'Pedido creado' }
      ],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    database.orders.push(newOrder);

    io.emit(`driver:${nearestDriver.id}`, {
      type: 'new_order',
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

app.get('/api/orders', authenticateToken, (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let orders;
    if (userRole === 'client') {
      orders = database.orders.filter(o => o.customerId === userId);
    } else if (userRole === 'driver') {
      orders = database.orders.filter(o => o.driverId === userId);
    } else {
      orders = database.orders;
    }

    orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
      orders,
      total: orders.length
    });
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
      return res.status(403).json({ error: 'No autorizado' });
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
    const userId = req.user.id;

    const order = database.orders.find(o => o.id === orderId);
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    if (req.user.role === 'client' && order.customerId !== userId) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    if (req.user.role === 'driver' && order.driverId !== userId) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const validStatuses = ['pending', 'accepted', 'preparing', 'on_way', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    order.status = status;
    order.updatedAt = new Date();
    order.statusHistory.push({
      status,
      timestamp: new Date(),
      note: note || '',
      updatedBy: userId
    });

    if (status === 'delivered') {
      order.deliveredAt = new Date();
      const driver = database.users.find(u => u.id === order.driverId);
      if (driver) {
        driver.totalDeliveries += 1;
        driver.totalEarnings += order.driverEarnings;
        driver.available = true;
      }
    }

    if (status === 'accepted') {
      order.acceptedAt = new Date();
      const driver = database.users.find(u => u.id === order.driverId);
      if (driver) {
        driver.available = false;
      }
    }

    io.emit(`client:${order.customerId}`, {
      type: 'order_update',
      order
    });

    res.json({
      message: 'Estado actualizado exitosamente',
      order
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar estado', details: error.message });
  }
});

// ============================================
// RUTAS DE USUARIO
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
// RUTAS DE ADMINISTRADOR
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
    res.status(500).json({ error: 'Error al obtener conductores pendientes', details: error.message });
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
      message: 'Conductor aprobado exitosamente',
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

    res.json({ message: 'Conductor rechazado y eliminado' });
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
    }

    res.json({ stats });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estadísticas', details: error.message });
  }
});

// ============================================
// WebSocket
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
// RUTAS ADICIONALES
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    uptime: process.uptime()
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📡 WebSocket habilitado`);
  console.log(`💰 Comisión: ${COMMISSION_RATE * 100}% | Fee: $${SERVICE_FEE}`);
  console.log(`\n🌐 URLs disponibles:`);
  console.log(`   / → Landing`);
  console.log(`   /cliente → Panel Cliente`);
  console.log(`   /conductor → Panel Conductor`);
  console.log(`   /admin → Panel Admin`);
});

module.exports = { app, server, io };
// v2.0 - Sistema con validación de fotos 20251121
