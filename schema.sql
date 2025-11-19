-- ============================================
-- ESQUEMA DE BASE DE DATOS - SISTEMA DELIVERY
-- PostgreSQL 14+
-- ============================================

-- Eliminar tablas si existen (para desarrollo)
DROP TABLE IF EXISTS ratings CASCADE;
DROP TABLE IF EXISTS order_status_history CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS driver_locations CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- ============================================
-- TABLA: users
-- ============================================
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('client', 'driver', 'admin')),
    
    -- Campos comunes
    profile_image VARCHAR(500),
    is_active BOOLEAN DEFAULT true,
    email_verified BOOLEAN DEFAULT false,
    
    -- Campos específicos de cliente
    address TEXT,
    default_location JSONB, -- { lat: number, lng: number, address: string }
    
    -- Campos específicos de conductor
    vehicle VARCHAR(255),
    license VARCHAR(100),
    vehicle_plate VARCHAR(50),
    vehicle_type VARCHAR(50), -- moto, carro, bicicleta
    is_available BOOLEAN DEFAULT true,
    current_location JSONB, -- { lat: number, lng: number }
    rating DECIMAL(3,2) DEFAULT 5.00,
    total_deliveries INTEGER DEFAULT 0,
    total_earnings DECIMAL(10,2) DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- Índices para users
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_is_available ON users(is_available) WHERE role = 'driver';

-- ============================================
-- TABLA: orders
-- ============================================
CREATE TABLE orders (
    id VARCHAR(50) PRIMARY KEY,
    order_number SERIAL UNIQUE NOT NULL,
    
    -- Relaciones
    customer_id INTEGER NOT NULL REFERENCES users(id),
    driver_id INTEGER REFERENCES users(id),
    
    -- Información del pedido
    items JSONB NOT NULL, -- Array de { name, quantity, price, notes }
    
    -- Ubicaciones
    pickup_location JSONB, -- { lat, lng, address, name }
    delivery_location JSONB NOT NULL, -- { lat, lng, address, contact_name, contact_phone }
    
    -- Estado
    status VARCHAR(20) NOT NULL DEFAULT 'pending' 
        CHECK (status IN ('pending', 'accepted', 'preparing', 'ready', 'on_way', 'delivered', 'cancelled')),
    
    -- Montos
    subtotal DECIMAL(10,2) NOT NULL,
    delivery_fee DECIMAL(10,2) NOT NULL,
    service_fee DECIMAL(10,2) DEFAULT 0,
    discount DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(10,2) NOT NULL,
    
    -- Información adicional
    payment_method VARCHAR(50) NOT NULL DEFAULT 'cash', -- cash, card, wallet
    payment_status VARCHAR(20) DEFAULT 'pending', -- pending, completed, failed
    
    distance DECIMAL(10,2), -- en kilómetros
    estimated_time INTEGER, -- en minutos
    actual_time INTEGER, -- tiempo real de entrega
    
    notes TEXT,
    cancellation_reason TEXT,
    
    -- Imágenes
    delivery_proof_image VARCHAR(500), -- foto de la entrega
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    accepted_at TIMESTAMP,
    preparing_at TIMESTAMP,
    on_way_at TIMESTAMP,
    delivered_at TIMESTAMP,
    cancelled_at TIMESTAMP
);

-- Índices para orders
CREATE INDEX idx_orders_customer_id ON orders(customer_id);
CREATE INDEX idx_orders_driver_id ON orders(driver_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX idx_orders_order_number ON orders(order_number);

-- ============================================
-- TABLA: order_items (alternativa a JSONB)
-- ============================================
CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id VARCHAR(50) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    
    product_name VARCHAR(255) NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(10,2) NOT NULL,
    subtotal DECIMAL(10,2) NOT NULL,
    
    notes TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_order_items_order_id ON order_items(order_id);

-- ============================================
-- TABLA: order_status_history
-- ============================================
CREATE TABLE order_status_history (
    id SERIAL PRIMARY KEY,
    order_id VARCHAR(50) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    
    status VARCHAR(20) NOT NULL,
    note TEXT,
    location JSONB, -- ubicación cuando cambió el estado
    
    updated_by INTEGER REFERENCES users(id),
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_order_status_history_order_id ON order_status_history(order_id);
CREATE INDEX idx_order_status_history_created_at ON order_status_history(created_at DESC);

-- ============================================
-- TABLA: driver_locations (tracking en tiempo real)
-- ============================================
CREATE TABLE driver_locations (
    id SERIAL PRIMARY KEY,
    driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    latitude DECIMAL(10,8) NOT NULL,
    longitude DECIMAL(11,8) NOT NULL,
    accuracy DECIMAL(10,2), -- precisión en metros
    speed DECIMAL(10,2), -- velocidad en km/h
    heading DECIMAL(5,2), -- dirección 0-360 grados
    
    order_id VARCHAR(50) REFERENCES orders(id), -- si está en entrega
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_driver_locations_driver_id ON driver_locations(driver_id);
CREATE INDEX idx_driver_locations_order_id ON driver_locations(order_id);
CREATE INDEX idx_driver_locations_created_at ON driver_locations(created_at DESC);

-- ============================================
-- TABLA: ratings
-- ============================================
CREATE TABLE ratings (
    id SERIAL PRIMARY KEY,
    order_id VARCHAR(50) NOT NULL REFERENCES orders(id),
    
    -- Quién califica a quién
    rater_id INTEGER NOT NULL REFERENCES users(id), -- quien califica
    rated_id INTEGER NOT NULL REFERENCES users(id), -- quien recibe la calificación
    
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    
    -- Calificaciones específicas
    punctuality INTEGER CHECK (punctuality BETWEEN 1 AND 5),
    communication INTEGER CHECK (communication BETWEEN 1 AND 5),
    service_quality INTEGER CHECK (service_quality BETWEEN 1 AND 5),
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(order_id, rater_id, rated_id)
);

CREATE INDEX idx_ratings_rated_id ON ratings(rated_id);
CREATE INDEX idx_ratings_order_id ON ratings(order_id);

-- ============================================
-- TABLA: notifications
-- ============================================
CREATE TABLE notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    type VARCHAR(50) NOT NULL, -- order_update, new_order, promotion, etc
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    
    data JSONB, -- datos adicionales (order_id, etc)
    
    is_read BOOLEAN DEFAULT false,
    read_at TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_is_read ON notifications(is_read);
CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC);

-- ============================================
-- FUNCIONES Y TRIGGERS
-- ============================================

-- Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger para users
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Trigger para orders
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Función para actualizar rating del conductor
CREATE OR REPLACE FUNCTION update_driver_rating()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE users
    SET rating = (
        SELECT AVG(rating)::DECIMAL(3,2)
        FROM ratings
        WHERE rated_id = NEW.rated_id
    )
    WHERE id = NEW.rated_id AND role = 'driver';
    
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger para actualizar rating cuando se crea una nueva calificación
CREATE TRIGGER update_rating_after_insert AFTER INSERT ON ratings
    FOR EACH ROW EXECUTE FUNCTION update_driver_rating();

-- ============================================
-- VISTAS ÚTILES
-- ============================================

-- Vista de órdenes con información completa
CREATE OR REPLACE VIEW orders_detailed AS
SELECT 
    o.*,
    c.name as customer_name,
    c.phone as customer_phone,
    c.email as customer_email,
    d.name as driver_name,
    d.phone as driver_phone,
    d.vehicle as driver_vehicle,
    d.rating as driver_rating
FROM orders o
LEFT JOIN users c ON o.customer_id = c.id
LEFT JOIN users d ON o.driver_id = d.id;

-- Vista de estadísticas de conductores
CREATE OR REPLACE VIEW driver_stats AS
SELECT 
    u.id,
    u.name,
    u.email,
    u.phone,
    u.rating,
    u.total_deliveries,
    u.total_earnings,
    u.is_available,
    COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'delivered' AND DATE(o.delivered_at) = CURRENT_DATE) as deliveries_today,
    COUNT(DISTINCT o.id) FILTER (WHERE o.status NOT IN ('delivered', 'cancelled')) as active_orders,
    AVG(o.actual_time) FILTER (WHERE o.status = 'delivered') as avg_delivery_time
FROM users u
LEFT JOIN orders o ON o.driver_id = u.id
WHERE u.role = 'driver'
GROUP BY u.id;

-- ============================================
-- DATOS DE PRUEBA (SEED)
-- ============================================

-- Usuario cliente de prueba
INSERT INTO users (email, password, name, phone, role, address, default_location)
VALUES 
(
    'cliente@delivery.com',
    '$2b$10$rQ5QJ8YhX6o9vZ5mXkJZCO3lKJ7qkzFGHJ9Vl5xJ8YhX6o9vZ5mXk', -- cliente123
    'Juan Cliente',
    '5512345678',
    'client',
    'Av. Insurgentes Sur 1234, Col. Del Valle, CDMX',
    '{"lat": 19.4326, "lng": -99.1332, "address": "Av. Insurgentes Sur 1234, CDMX"}'
);

-- Usuarios conductores de prueba
INSERT INTO users (email, password, name, phone, role, vehicle, license, vehicle_plate, vehicle_type, is_available, current_location, rating, total_deliveries)
VALUES 
(
    'conductor1@delivery.com',
    '$2b$10$rQ5QJ8YhX6o9vZ5mXkJZCO3lKJ7qkzFGHJ9Vl5xJ8YhX6o9vZ5mXk', -- conductor123
    'Pedro Conductor',
    '5587654321',
    'driver',
    'Moto Honda CBR 250',
    'ABC123456',
    'ABC-123-D',
    'moto',
    true,
    '{"lat": 19.4326, "lng": -99.1332}',
    4.8,
    150
),
(
    'conductor2@delivery.com',
    '$2b$10$rQ5QJ8YhX6o9vZ5mXkJZCO3lKJ7qkzFGHJ9Vl5xJ8YhX6o9vZ5mXk',
    'María Rápida',
    '5598765432',
    'driver',
    'Italika FT 150',
    'XYZ789012',
    'XYZ-789-M',
    'moto',
    true,
    '{"lat": 19.4200, "lng": -99.1500}',
    4.9,
    203
),
(
    'conductor3@delivery.com',
    '$2b$10$rQ5QJ8YhX6o9vZ5mXkJZCO3lKJ7qkzFGHJ9Vl5xJ8YhX6o9vZ5mXk',
    'Carlos Veloz',
    '5576543210',
    'driver',
    'Yamaha Vixion 150',
    'DEF456789',
    'DEF-456-V',
    'moto',
    true,
    '{"lat": 19.4400, "lng": -99.1200}',
    4.7,
    89
);

-- Usuario administrador
INSERT INTO users (email, password, name, phone, role)
VALUES 
(
    'admin@delivery.com',
    '$2b$10$rQ5QJ8YhX6o9vZ5mXkJZCO3lKJ7qkzFGHJ9Vl5xJ8YhX6o9vZ5mXk', -- admin123
    'Administrador Sistema',
    '5500000000',
    'admin'
);

-- ============================================
-- COMENTARIOS Y DOCUMENTACIÓN
-- ============================================

COMMENT ON TABLE users IS 'Usuarios del sistema: clientes, conductores y administradores';
COMMENT ON TABLE orders IS 'Pedidos realizados en el sistema';
COMMENT ON TABLE order_status_history IS 'Historial de cambios de estado de cada pedido';
COMMENT ON TABLE driver_locations IS 'Tracking de ubicación en tiempo real de conductores';
COMMENT ON TABLE ratings IS 'Calificaciones entre usuarios';
COMMENT ON TABLE notifications IS 'Notificaciones push para usuarios';

-- ============================================
-- PERMISOS (ajustar según tu configuración)
-- ============================================

-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO delivery_app;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO delivery_app;