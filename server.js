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

// --- CONSTANTES DE CONFIGURACIÓN ---
const JWT_SECRET = process.env.JWT_SECRET || 'mi_secreto_super_seguro';
const PORT = process.env.PORT || 3000;
const SERVICE_FEE = parseFloat(process.env.SERVICE_FEE || 0.10); // 10% de comisión

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

// --- MIDDLEWARE ---
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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- AUTENTICACIÓN Y AUTORIZACIÓN MIDDLEWARE ---

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (token == null) return res.status(401).json({ error: 'Token no proporcionado' });

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) {
      console.error('Error de verificación JWT:', err.message);
      return res.status(403).json({ error: 'Token inválido o expirado' });
    }
    
    try {
      req.user = await User.findByPk(user.id);
      if (!req.user) return res.status(404).json({ error: 'Usuario no encontrado' });
      next();
    } catch (dbError) {
      console.error('Error al buscar usuario en DB:', dbError);
      res.status(500).json({ error: 'Error al procesar la autenticación' });
    }
  });
};

const checkRole = (requiredRole) => (req, res, next) => {
  if (req.user.role !== requiredRole) {
    return res.status(403).json({ error: 'Acceso denegado. Rol insuficiente.' });
  }
  next();
};

const router = express.Router();

// --- RUTAS DE AUTENTICACIÓN ---

router.post('/auth/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashedPassword, role });
    
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    
    res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    console.error('Error de registro:', error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'El correo electrónico ya está registrado' });
    }
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.post('/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email } });

    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '1h' });

    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    console.error('Error de login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.get('/users/profile', authenticateToken, (req, res) => {
    res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role } });
});

// --- RUTAS DE TIENDA (STORE) ---

// POST /stores: CREAR TIENDA
router.post('/stores', authenticateToken, checkRole('store_owner'), multer().single('logo'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'El logo de la tienda es requerido' });
        }

        // Usar req.file.buffer y especificar 'stores'
        const logoUrl = await uploadImage(req.file.buffer, 'stores'); 

        const { name, description, address, phone, category } = req.body;
        const newStore = await Store.create({
            name,
            description,
            address,
            phone,
            category,
            logoUrl, 
            ownerId: req.user.id,
            isOpen: true,
            rating: 0,
            deliveryTime: '30-45 min',
            // Agregando valores predeterminados para evitar la Violación NotNull
            deliveryFee: 0, 
            minOrder: 0,    
            location: address || 'Ubicación no especificada', 
        });

        res.status(201).json({ store: newStore });
    } catch (error) {
        console.error('Error al crear tienda:', error);
        res.status(500).json({ error: 'Error interno del servidor al crear la tienda' });
    }
});

// GET /stores: OBTENER TODAS LAS TIENDAS
router.get('/stores', authenticateToken, async (req, res) => {
    try {
        const stores = await Store.findAll({
            include: { model: User, as: 'owner', attributes: ['name', 'email'] }
        });
        res.json({ stores });
    } catch (error) {
        console.error('Error al obtener tiendas:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /stores/:id: ACTUALIZAR TIENDA
router.put('/stores/:id', authenticateToken, checkRole('store_owner'), async (req, res) => {
    try {
        const store = await Store.findByPk(req.params.id);
        
        if (!store) {
            return res.status(404).json({ error: 'Tienda no encontrada' });
        }
        
        if (store.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'No tienes permiso para actualizar esta tienda' });
        }

        await store.update(req.body);
        res.json({ store });
    } catch (error) {
        console.error('Error al actualizar tienda:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});


// --- RUTAS DE PRODUCTO ---

// POST /products: CREAR PRODUCTO
router.post('/products', authenticateToken, checkRole('store_owner'), multer().single('image'), async (req, res) => {
    try {
        const { storeId, name, description, price, category } = req.body;

        if (!req.file) {
            return res.status(400).json({ error: 'La imagen del producto es requerida' });
        }
        
        // Verificar que la tienda exista y pertenezca al usuario
        const store = await Store.findByPk(storeId);
        if (!store || store.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'Tienda no válida o no te pertenece' });
        }

        // Usar req.file.buffer y especificar 'products' 
        const imageUrl = await uploadImage(req.file.buffer, 'products');

        const product = await Product.create({
            storeId,
            name,
            description,
            price: parseFloat(price),
            category,
            imageUrl, 
            available: true
        });

        res.status(201).json({ product });
    } catch (error) {
        console.error('Error al crear producto:', error);
        res.status(500).json({ error: 'Error interno del servidor al crear el producto' });
    }
});

// GET /stores/:storeId/products: OBTENER PRODUCTOS DE UNA TIENDA
router.get('/stores/:storeId/products', authenticateToken, async (req, res) => {
    try {
        const products = await Product.findAll({ where: { storeId: req.params.storeId } });
        res.json({ products });
    } catch (error) {
        console.error('Error al obtener productos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// PUT /products/:id: ACTUALIZAR PRODUCTO (Incluyendo disponibilidad)
router.put('/products/:id', authenticateToken, checkRole('store_owner'), async (req, res) => {
    try {
        const product = await Product.findByPk(req.params.id, { include: Store });
        
        if (!product) {
            return res.status(404).json({ error: 'Producto no encontrado' });
        }
        
        if (product.Store.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'No tienes permiso para actualizar este producto' });
        }

        await product.update(req.body);
        res.json({ product });
    } catch (error) {
        console.error('Error al actualizar producto:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// DELETE /products/:id: ELIMINAR PRODUCTO
router.delete('/products/:id', authenticateToken, checkRole('store_owner'), async (req, res) => {
    try {
        const product = await Product.findByPk(req.params.id, { include: Store });
        
        if (!product) {
            return res.status(404).json({ error: 'Producto no encontrado' });
        }
        
        if (product.Store.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'No tienes permiso para eliminar este producto' });
        }
        
        // Eliminar imagen de Cloudinary
        if (product.imageUrl) {
            await deleteImage(product.imageUrl);
        }

        await product.destroy();
        res.status(204).send();
    } catch (error) {
        console.error('Error al eliminar producto:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});


// --- RUTAS DE PEDIDOS (ORDER) ---

// GET /orders: OBTENER PEDIDOS (Filtro por rol)
router.get('/orders', authenticateToken, async (req, res) => {
    try {
        let whereClause = {};
        
        if (req.user.role === 'store_owner') {
            const myStores = await Store.findAll({ where: { ownerId: req.user.id }, attributes: ['id'] });
            const storeIds = myStores.map(s => s.id);
            if (storeIds.length === 0) {
                return res.json({ orders: [] });
            }
            whereClause = { storeId: storeIds };
        } else if (req.user.role === 'client') {
            whereClause = { userId: req.user.id };
        } 

        const orders = await Order.findAll({
            where: whereClause,
            include: [
                { model: User, as: 'customer', attributes: ['name', 'email', 'phone'] },
                // ✅ CORRECCIÓN FINAL: Usar 'direccion' para evitar el error 'column store.address no existe'
                { model: Store, as: 'store', attributes: ['name', 'direccion', 'phone'] } 
            ],
            order: [['createdAt', 'DESC']]
        });

        res.json({ orders });
    } catch (error) {
        console.error('Error al obtener pedidos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});


// PUT /orders/:id/status: ACTUALIZAR ESTADO DEL PEDIDO (Para tienda o driver)
router.put('/orders/:id/status', authenticateToken, async (req, res) => {
    try {
        const { status, note } = req.body;
        const order = await Order.findByPk(req.params.id, { include: Store });

        if (!order) {
            return res.status(404).json({ error: 'Pedido no encontrado' });
        }

        // Lógica de autorización
        const isStoreOwner = req.user.role === 'store_owner' && order.Store.ownerId === req.user.id;
        const isDriver = req.user.role === 'driver';
        
        if (!isStoreOwner && !isDriver) {
            return res.status(403).json({ error: 'No tienes permiso para actualizar este pedido' });
        }
        
        // Lógica de transición de estado (simplificada)
        const storeCanUpdate = ['pending', 'accepted', 'preparing'].includes(order.status);
        const driverCanUpdate = ['ready', 'picked_up', 'on_way'].includes(order.status) && isDriver;

        if ((isStoreOwner && storeCanUpdate) || driverCanUpdate || status === 'cancelled') {
            await order.update({ status, note });
            
            // Notificar a los interesados a través de sockets
            io.emit('orderUpdate', { orderId: order.id, newStatus: status });

            res.json({ order });
        } else {
            return res.status(400).json({ error: 'Transición de estado no permitida para tu rol o estado actual' });
        }

    } catch (error) {
        console.error('Error al actualizar estado del pedido:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});


// --- RUTAS DE ESTADÍSTICAS ---

router.get('/stats', authenticateToken, checkRole('store_owner'), async (req, res) => {
    try {
        const myStores = await Store.findAll({ where: { ownerId: req.user.id } });
        const storeIds = myStores.map(s => s.id);

        if (storeIds.length === 0) {
            return res.json({ stats: { 
                totalStores: 0, totalProducts: 0, totalOrders: 0, totalRevenue: 0, ordersToday: 0, activeOrders: 0 
            }});
        }

        const totalOrders = await Order.count({ where: { storeId: storeIds } });
        const totalProducts = await Product.count({ where: { storeId: storeIds } });
        const totalRevenueResult = await Order.sum('subtotal', { where: { storeId: storeIds, status: 'delivered' } });
        const totalRevenue = totalRevenueResult || 0;

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const ordersToday = await Order.count({ 
            where: { 
                storeId: storeIds, 
                createdAt: { [sequelize.Op.gte]: today } 
            } 
        });

        const activeOrders = await Order.count({ 
            where: { 
                storeId: storeIds,
                status: { [sequelize.Op.notIn]: ['delivered', 'cancelled'] }
            }
        });

        res.json({ 
            stats: {
                totalStores: myStores.length,
                totalProducts,
                totalOrders,
                totalRevenue,
                ordersToday,
                activeOrders
            }
        });
    } catch (error) {
        console.error('Error al obtener estadísticas:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});


// --- CONFIGURACIÓN DE RUTAS FINALES ---
app.use('/api', router);

// Servir la aplicación principal
app.get('/:page?', (req, res) => {
  const page = req.params.page || 'index';
  const validPages = ['index', 'driver', 'tienda', 'admin', 'client'];
  
  if (validPages.includes(page)) {
    res.sendFile(path.join(__dirname, 'public', `${page}.html`));
  } else {
    // Si la página no es válida y no existe 404.html, enviar un mensaje 404 simple.
    res.status(404).send('404 | Página no encontrada.');
  }
});


// --- INICIO DEL SERVIDOR ---
async function startServer() {
  try {
    await testConnection();
    await sequelize.sync({ alter: true }); // Aplica cambios en la estructura de la DB

    server.listen(PORT, () => {
      console.log(`${'='.repeat(60)}`);
      console.log(`🚀 Servidor Express/Socket.io corriendo en http://localhost:${PORT}`);
      console.log(`🔌 Conectado a la DB: ${process.env.DB_NAME}`);
      console.log(`💰 Comisión de servicio: ${SERVICE_FEE}`);
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
    console.log('Servidor cerrado.');
    process.exit(0);
  });
});

startServer();