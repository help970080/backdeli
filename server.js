const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Constantes
const JWT_SECRET = 'tu-secreto-super-seguro';
const PORT = 3000;
const COMMISSION_RATE = 0.20; // 20% para ti
const SERVICE_FEE = 10; // $10 fijo para ti

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
  orderCounter: 1
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

    // CÁLCULOS CON COMISIÓN
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
      return res.status(403).json({ error: 'No autorizado - Solo administradores' });
    }

    const allOrders = database.orders;
    const completedOrders = allOrders.filter(o => o.status === 'delivered');
    const today = new Date().toDateString();

    const stats = {
      // Pedidos
      totalOrders: allOrders.length,
      completedOrders: completedOrders.length,
      pendingOrders: allOrders.filter(o => o.status === 'pending').length,
      activeOrders: allOrders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length,
      cancelledOrders: allOrders.filter(o => o.status === 'cancelled').length,
      
      // GANANCIAS DE LA PLATAFORMA (LO QUE TÚ GANAS)
      totalPlatformEarnings: completedOrders.reduce((sum, o) => sum + (o.platformEarnings || 0), 0),
      totalCommissions: completedOrders.reduce((sum, o) => sum + (o.commission || 0), 0),
      totalServiceFees: completedOrders.reduce((sum, o) => sum + (o.serviceFee || 0), 0),
      
      // Lo que han ganado los conductores
      totalDriverEarnings: completedOrders.reduce((sum, o) => sum + (o.driverEarnings || 0), 0),
      
      // Ingresos totales del sistema
      totalRevenue: completedOrders.reduce((sum, o) => sum + o.total, 0),
      
      // Conductores
      totalDrivers: database.users.filter(u => u.role === 'driver').length,
      availableDrivers: database.users.filter(u => u.role === 'driver' && u.available).length,
      
      // Clientes
      totalClients: database.users.filter(u => u.role === 'client').length,
      
      // Estadísticas del día
      today: today,
      ordersToday: allOrders.filter(o => new Date(o.createdAt).toDateString() === today).length,
      earningsToday: completedOrders
        .filter(o => o.deliveredAt && new Date(o.deliveredAt).toDateString() === today)
        .reduce((sum, o) => sum + (o.platformEarnings || 0), 0),
      
      // Promedios
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

// ============================================
// RUTAS DE ESTADÍSTICAS
// ============================================

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

app.get('/', (req, res) => {
  res.json({
    message: '🚚 API de Sistema de Delivery',
    version: '2.0.0',
    features: ['Comisiones', 'Estadísticas Admin', 'Tracking en tiempo real']
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📡 WebSocket habilitado para tiempo real`);
  console.log(`💰 Comisión: ${COMMISSION_RATE * 100}% | Fee: $${SERVICE_FEE}`);
  console.log(`\n📝 Credenciales de prueba:`);
  console.log(`   Cliente: cliente@delivery.com / cliente123`);
  console.log(`   Conductor: conductor@delivery.com / conductor123`);
  console.log(`   Admin: admin@delivery.com / admin123`);
});

module.exports = { app, server, io };