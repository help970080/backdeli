// migrate.js
require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  try {
    await client.connect();
    console.log('✅ Conectado a la base de datos');

    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended BOOLEAN DEFAULT false;
    `);
    console.log('✅ Campo suspended agregado');

    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMP;
    `);
    console.log('✅ Campo suspendedAt agregado');

    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS "suspensionReason" TEXT;
    `);
    console.log('✅ Campo suspensionReason agregado');

    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS "lastPaymentDate" TIMESTAMP;
    `);
    console.log('✅ Campo lastPaymentDate agregado');

    await client.query(`
      UPDATE users SET suspended = false WHERE role = 'driver' AND suspended IS NULL;
    `);
    console.log('✅ Conductores actualizados');

    console.log('\n🎉 ¡Migración completada exitosamente!\n');
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Detalles:', error);
  } finally {
    await client.end();
  }
}

migrate();