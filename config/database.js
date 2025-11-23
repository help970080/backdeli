const { Sequelize } = require('sequelize');

// ============================================
// CONFIGURACIÓN DE POSTGRESQL
// ============================================

// Leer DATABASE_URL desde variables de entorno
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ ERROR: DATABASE_URL no está configurado en .env');
  console.error('💡 Agrega esta línea a tu archivo .env:');
  console.error('   DATABASE_URL=postgres://usuario:password@host:5432/database');
  process.exit(1);
}

// Crear instancia de Sequelize
const sequelize = new Sequelize(DATABASE_URL, {
  dialect: 'postgres',
  dialectOptions: {
    ssl: process.env.NODE_ENV === 'production' ? {
      require: true,
      rejectUnauthorized: false // Necesario para Render
    } : false
  },
  logging: process.env.NODE_ENV === 'development' ? console.log : false, // Logs solo en desarrollo
  pool: {
    max: 5,        // Máximo 5 conexiones
    min: 0,        // Mínimo 0 conexiones
    acquire: 30000, // Timeout para adquirir conexión (30 seg)
    idle: 10000    // Cerrar conexiones inactivas después de 10 seg
  }
});

// ============================================
// FUNCIÓN PARA PROBAR CONEXIÓN
// ============================================

async function testConnection() {
  try {
    await sequelize.authenticate();
    console.log('✅ Conexión a PostgreSQL establecida correctamente');
    return true;
  } catch (error) {
    console.error('❌ Error conectando a PostgreSQL:');
    console.error('   Mensaje:', error.message);
    console.error('\n💡 Soluciones posibles:');
    console.error('   1. Verifica que DATABASE_URL esté correcto en .env');
    console.error('   2. Verifica que la base de datos exista');
    console.error('   3. Verifica las credenciales de usuario/password');
    console.error('   4. Verifica que PostgreSQL esté corriendo\n');
    return false;
  }
}

module.exports = { sequelize, testConnection };