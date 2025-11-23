const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

// ============================================
// MODELO: USERS
// ============================================
const User = sequelize.define('User', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  email: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false,
    validate: {
      isEmail: true
    }
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: false
  },
  role: {
    type: DataTypes.ENUM('client', 'driver', 'store_owner', 'admin'),
    allowNull: false
  },
  address: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Campos específicos de conductor
  vehicle: {
    type: DataTypes.STRING,
    allowNull: true
  },
  license: {
    type: DataTypes.STRING,
    allowNull: true
  },
  inePhoto: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  vehiclePhoto: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  available: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  approved: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  currentLocation: {
    type: DataTypes.JSONB,
    defaultValue: { lat: 19.4326, lng: -99.1332 }
  },
  rating: {
    type: DataTypes.FLOAT,
    defaultValue: 5.0
  },
  totalDeliveries: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  totalEarnings: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  }
}, {
  tableName: 'users',
  timestamps: true
});

// ============================================
// MODELO: STORES
// ============================================
const Store = sequelize.define('Store', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT
  },
  category: {
    type: DataTypes.STRING,
    allowNull: false
  },
  image: {
    type: DataTypes.STRING
  },
  rating: {
    type: DataTypes.FLOAT,
    defaultValue: 5.0
  },
  deliveryTime: {
    type: DataTypes.STRING,
    defaultValue: '30-40 min'
  },
  deliveryFee: {
    type: DataTypes.FLOAT,
    allowNull: false
  },
  minOrder: {
    type: DataTypes.FLOAT,
    allowNull: false
  },
  isOpen: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  location: {
    type: DataTypes.JSONB,
    allowNull: false
  },
  ownerId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  }
}, {
  tableName: 'stores',
  timestamps: true
});

// ============================================
// MODELO: PRODUCTS
// ============================================
const Product = sequelize.define('Product', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  storeId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'stores',
      key: 'id'
    }
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT
  },
  price: {
    type: DataTypes.FLOAT,
    allowNull: false
  },
  image: {
    type: DataTypes.STRING
  },
  category: {
    type: DataTypes.STRING
  },
  available: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  preparationTime: {
    type: DataTypes.INTEGER,
    defaultValue: 15
  }
}, {
  tableName: 'products',
  timestamps: true
});

// ============================================
// MODELO: ORDERS
// ============================================
const Order = sequelize.define('Order', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  orderNumber: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  customerId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  storeId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'stores',
      key: 'id'
    }
  },
  driverId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  items: {
    type: DataTypes.JSONB,
    allowNull: false
  },
  subtotal: {
    type: DataTypes.FLOAT,
    allowNull: false
  },
  deliveryFee: {
    type: DataTypes.FLOAT,
    allowNull: false
  },
  serviceFee: {
    type: DataTypes.FLOAT,
    defaultValue: 10
  },
  commission: {
    type: DataTypes.FLOAT,
    allowNull: false
  },
  total: {
    type: DataTypes.FLOAT,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('pending', 'accepted', 'preparing', 'ready', 'picked_up', 'on_way', 'delivered', 'cancelled'),
    defaultValue: 'pending'
  },
  deliveryAddress: {
    type: DataTypes.JSONB,
    allowNull: false
  },
  paymentMethod: {
    type: DataTypes.STRING,
    allowNull: false
  },
  notes: {
    type: DataTypes.TEXT
  },
  distance: {
    type: DataTypes.FLOAT,
    defaultValue: 5.0
  },
  driverEarnings: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  platformEarnings: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  statusHistory: {
    type: DataTypes.JSONB,
    defaultValue: []
  },
  acceptedAt: {
    type: DataTypes.DATE
  },
  readyAt: {
    type: DataTypes.DATE
  },
  pickedUpAt: {
    type: DataTypes.DATE
  },
  deliveredAt: {
    type: DataTypes.DATE
  },
  assignedAt: {
    type: DataTypes.DATE
  }
}, {
  tableName: 'orders',
  timestamps: true
});

// ============================================
// RELACIONES
// ============================================

// User tiene muchas tiendas
User.hasMany(Store, { foreignKey: 'ownerId', as: 'stores' });
Store.belongsTo(User, { foreignKey: 'ownerId', as: 'owner' });

// Store tiene muchos productos
Store.hasMany(Product, { foreignKey: 'storeId', as: 'products' });
Product.belongsTo(Store, { foreignKey: 'storeId', as: 'store' });

// Order pertenece a User (customer)
Order.belongsTo(User, { foreignKey: 'customerId', as: 'customer' });

// Order pertenece a User (driver)
Order.belongsTo(User, { foreignKey: 'driverId', as: 'driver' });

// Order pertenece a Store
Order.belongsTo(Store, { foreignKey: 'storeId', as: 'store' });

module.exports = {
  User,
  Store,
  Product,
  Order,
  sequelize
};