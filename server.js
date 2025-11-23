const order = await Order.findByPk(orderId, {
      include: [{ model: Store, as: 'store' }]
    });

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

    const updates = { status };
    const statusHistory = [...order.statusHistory, {
      status,
      timestamp: new Date(),
      note: note || '',
      updatedBy: req.user.id
    }];
    updates.statusHistory = statusHistory;

    // ✅ CRÍTICO: Asignar conductor automáticamente al recoger
    if (status === ORDER_STATES.PICKED_UP) {
      updates.pickedUpAt = new Date();
      
      // Si no tiene conductor asignado, asignarlo ahora
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
        await driver.update({
          totalDeliveries: driver.totalDeliveries + 1,
          totalEarnings: driver.totalEarnings + order.driverEarnings
        });
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

    res.json({ 
      message: 'Estado actualizado exitosamente',
      order 
    });
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
    const order = await Order.findByPk(orderId, {
      include: [{ model: Store, as: 'store' }]
    });

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
      attributes: { exclude: ['password', 'email'] }
    });

    const driversWithOrders = await Promise.all(drivers.map(async (driver) => {
      const activeOrders = await Order.count({
        where: {
          driverId: driver.id,
          status: {
            [sequelize.Sequelize.Op.notIn]: ['delivered', 'cancelled']
          }
        }
      });

      return {
        ...driver.toJSON(),
        activeOrders
      };
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

    const driver = await User.findOne({ 
      where: { id: driverId, role: 'driver' }
    });

    if (!driver) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    if (!driver.approved) {
      return res.status(403).json({ error: 'Tu cuenta aún no ha sido aprobada' });
    }

    await driver.update({ available });

    res.json({ 
      message: `Estado cambiado a ${available ? 'disponible' : 'no disponible'}`,
      driver: { id: driver.id, available: driver.available }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar disponibilidad', details: error.message });
  }
});

app.put('/api/drivers/:driverId/location', authenticateToken, async (req, res) => {
  try {
    const { driverId } = req.params;
    const { lat, lng } = req.body;

    if (req.user.id !== parseInt(driverId)) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const driver = await User.findOne({ 
      where: { id: driverId, role: 'driver' }
    });

    if (!driver) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    await driver.update({
      currentLocation: { lat, lng }
    });

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

app.get('/api/admin/stats', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const allOrders = await Order.findAll();
    const completedOrders = await Order.findAll({ where: { status: 'delivered' } });
    const today = new Date().toDateString();

    const stats = {
      totalOrders: allOrders.length,
      completedOrders: completedOrders.length,
      pendingOrders: await Order.count({ where: { status: 'pending' } }),
      activeOrders: await Order.count({ 
        where: { 
          status: { 
            [sequelize.Sequelize.Op.notIn]: ['delivered', 'cancelled'] 
          } 
        } 
      }),
      cancelledOrders: await Order.count({ where: { status: 'cancelled' } }),
      totalPlatformEarnings: completedOrders.reduce((sum, o) => sum + (o.platformEarnings || 0), 0),
      totalCommissions: completedOrders.reduce((sum, o) => sum + (o.commission || 0), 0),
      totalServiceFees: completedOrders.reduce((sum, o) => sum + (o.serviceFee || 0), 0),
      totalDriverEarnings: completedOrders.reduce((sum, o) => sum + (o.driverEarnings || 0), 0),
      totalRevenue: completedOrders.reduce((sum, o) => sum + o.total, 0),
      totalDrivers: await User.count({ where: { role: 'driver', approved: true } }),
      pendingDrivers: await User.count({ where: { role: 'driver', approved: false } }),
      availableDrivers: await User.count({ where: { role: 'driver', available: true, approved: true } }),
      totalClients: await User.count({ where: { role: 'client' } }),
      totalStores: await Store.count(),
      totalProducts: await Product.count(),
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

app.get('/api/admin/drivers/pending', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const pendingDrivers = await User.findAll({ 
      where: { role: 'driver', approved: false },
      attributes: { exclude: ['password'] }
    });

    res.json({ drivers: pendingDrivers });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener conductores', details: error.message });
  }
});

app.put('/api/admin/drivers/:driverId/approve', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { driverId } = req.params;
    const driver = await User.findOne({ 
      where: { id: driverId, role: 'driver' }
    });

    if (!driver) {
      return res.status(404).json({ error: 'Conductor no encontrado' });
    }

    await driver.update({
      approved: true,
      available: true
    });

    notifyUser(driver.id, {
      title: '¡Cuenta aprobada!',
      message: 'Tu cuenta de conductor ha sido aprobada. Ya puedes comenzar a tomar pedidos.',
      type: 'success',
      timestamp: new Date()
    });

    res.json({
      message: 'Conductor aprobado',
      driver: { id: driver.id, name: driver.name, email: driver.email, approved: true }
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al aprobar conductor', details: error.message });
  }
});

app.delete('/api/admin/drivers/:driverId/reject', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const { driverId } = req.params;
    const driver = await User.findOne({ 
      where: { id: driverId, role: 'driver' }
    });

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

// ============================================
// MANEJO DE ERRORES GLOBAL
// ============================================

app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(err.status || 500).json({ 
    error: 'Error del servidor',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Ocurrió un error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
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

async function startServer() {
  try {
    // ✅ Conectar a PostgreSQL
    const dbConnected = await testConnection();
    
    if (!dbConnected) {
      console.error('❌ No se pudo conectar a PostgreSQL');
      console.error('💡 Verifica que DATABASE_URL esté configurado en .env');
      process.exit(1);
    }

    // ✅ Sincronizar modelos (crear tablas si no existen)
    await sequelize.sync({ alter: false });
    console.log('✅ Modelos sincronizados con PostgreSQL');

    // ✅ Verificar si hay usuarios, si no, sugerir seed
    const userCount = await User.count();
    if (userCount === 0) {
      console.log('\n⚠️  La base de datos está vacía');
      console.log('💡 Ejecuta: node scripts/seed.js para poblar datos iniciales\n');
    }

    // ✅ Iniciar servidor
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

// Manejar cierre graceful
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

// ✅ Iniciar servidor
startServer();

module.exports = { app, server, io };