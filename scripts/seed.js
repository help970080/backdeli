require('dotenv').config();
const bcrypt = require('bcryptjs');
const { User, Store, Product, sequelize } = require('../models');

async function seedDatabase() {
  try {
    console.log('🌱 Iniciando seed de base de datos...');

    // Sincronizar modelos (crea tablas si no existen)
    // ⚠️ force: true BORRA todas las tablas y las vuelve a crear
    await sequelize.sync({ force: true });
    console.log('✅ Tablas creadas');

    // ============================================
    // CREAR USUARIOS DE PRUEBA
    // ============================================
    console.log('👥 Creando usuarios...');

    const users = await User.bulkCreate([
      {
        email: 'cliente@delivery.com',
        password: await bcrypt.hash('cliente123', 10),
        name: 'Juan Cliente',
        phone: '5512345678',
        role: 'client',
        address: 'Av. Insurgentes Sur 1234, CDMX'
      },
      {
        email: 'conductor@delivery.com',
        password: await bcrypt.hash('conductor123', 10),
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
        totalEarnings: 0
      },
      {
        email: 'admin@delivery.com',
        password: await bcrypt.hash('admin123', 10),
        name: 'Administrador',
        phone: '5500000000',
        role: 'admin'
      },
      {
        email: 'tienda@delivery.com',
        password: await bcrypt.hash('tienda123', 10),
        name: 'María Comerciante',
        phone: '5599887766',
        role: 'store_owner'
      }
    ]);

    console.log(`✅ ${users.length} usuarios creados`);

    // ============================================
    // CREAR TIENDAS DE EJEMPLO
    // ============================================
    console.log('🏪 Creando tiendas...');

    const storeOwner = users.find(u => u.role === 'store_owner');

    const stores = await Store.bulkCreate([
      {
        name: 'Tacos El Güero',
        description: 'Los mejores tacos de la ciudad',
        category: 'Mexicana',
        image: '/uploads/stores/tacos.jpg',
        rating: 4.5,
        deliveryTime: '20-30 min',
        deliveryFee: 35,
        minOrder: 50,
        isOpen: true,
        ownerId: storeOwner.id,
        location: { 
          lat: 19.4326, 
          lng: -99.1332, 
          address: 'Av. Reforma 123' 
        }
      },
      {
        name: 'Pizzería Napolitana',
        description: 'Auténtica pizza italiana',
        category: 'Italiana',
        image: '/uploads/stores/pizza.jpg',
        rating: 4.7,
        deliveryTime: '30-40 min',
        deliveryFee: 40,
        minOrder: 80,
        isOpen: true,
        ownerId: storeOwner.id,
        location: { 
          lat: 19.4330, 
          lng: -99.1340, 
          address: 'Calle Roma 456' 
        }
      },
      {
        name: 'Sushi Tokyo',
        description: 'Sushi fresco y rolls especiales',
        category: 'Japonesa',
        image: '/uploads/stores/sushi.jpg',
        rating: 4.8,
        deliveryTime: '25-35 min',
        deliveryFee: 45,
        minOrder: 100,
        isOpen: true,
        ownerId: storeOwner.id,
        location: { 
          lat: 19.4335, 
          lng: -99.1335, 
          address: 'Av. Chapultepec 789' 
        }
      }
    ]);

    console.log(`✅ ${stores.length} tiendas creadas`);

    // ============================================
    // CREAR PRODUCTOS DE EJEMPLO
    // ============================================
    console.log('📦 Creando productos...');

    const products = await Product.bulkCreate([
      // Productos de Tacos El Güero
      {
        storeId: stores[0].id,
        name: 'Tacos de Pastor',
        description: 'Tradicionales tacos al pastor con piña',
        price: 45,
        image: '/uploads/products/tacos-pastor.jpg',
        category: 'Tacos',
        available: true,
        preparationTime: 10
      },
      {
        storeId: stores[0].id,
        name: 'Tacos de Bistec',
        description: 'Tacos de bistec con cebolla y cilantro',
        price: 50,
        image: '/uploads/products/tacos-bistec.jpg',
        category: 'Tacos',
        available: true,
        preparationTime: 12
      },
      // Productos de Pizzería Napolitana
      {
        storeId: stores[1].id,
        name: 'Pizza Margarita',
        description: 'Tomate, mozzarella y albahaca',
        price: 180,
        image: '/uploads/products/pizza-margarita.jpg',
        category: 'Pizzas',
        available: true,
        preparationTime: 25
      },
      {
        storeId: stores[1].id,
        name: 'Pizza Pepperoni',
        description: 'Pepperoni italiano y queso mozzarella',
        price: 200,
        image: '/uploads/products/pizza-pepperoni.jpg',
        category: 'Pizzas',
        available: true,
        preparationTime: 25
      },
      // Productos de Sushi Tokyo
      {
        storeId: stores[2].id,
        name: 'California Roll',
        description: 'Cangrejo, aguacate y pepino',
        price: 120,
        image: '/uploads/products/california-roll.jpg',
        category: 'Rolls',
        available: true,
        preparationTime: 15
      },
      {
        storeId: stores[2].id,
        name: 'Sashimi Mixto',
        description: 'Selección de pescados frescos',
        price: 250,
        image: '/uploads/products/sashimi.jpg',
        category: 'Sashimi',
        available: true,
        preparationTime: 10
      }
    ]);

    console.log(`✅ ${products.length} productos creados`);

    console.log('\n🎉 ¡Seed completado exitosamente!');
    console.log('\n📊 Resumen:');
    console.log(`   👥 Usuarios: ${users.length}`);
    console.log(`   🏪 Tiendas: ${stores.length}`);
    console.log(`   📦 Productos: ${products.length}`);
    console.log('\n👥 Usuarios creados:');
    console.log('   Cliente:    cliente@delivery.com / cliente123');
    console.log('   Conductor:  conductor@delivery.com / conductor123');
    console.log('   Tienda:     tienda@delivery.com / tienda123');
    console.log('   Admin:      admin@delivery.com / admin123');
    console.log('\n✅ Ya puedes iniciar el servidor con: node server.js\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error en seed:', error);
    process.exit(1);
  }
}

// Ejecutar seed
seedDatabase();