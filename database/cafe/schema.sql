-- Copyright (c) 2026 Intel Corporation
--
-- SPDX-License-Identifier: Apache-2.0

-- EdgeMart Café Database Schema
-- PostgreSQL

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Categories table
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Products table
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(200) NOT NULL,
    sku VARCHAR(50) UNIQUE NOT NULL,
    barcode VARCHAR(50) UNIQUE,
    category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
    price DECIMAL(10, 2) NOT NULL CHECK (price >= 0),
    cost DECIMAL(10, 2) DEFAULT 0 CHECK (cost >= 0),
    stock_quantity INTEGER DEFAULT 0 CHECK (stock_quantity >= 0),
    unit VARCHAR(20) DEFAULT 'each',
    image_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    last_replenished_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Customers table (for loyalty/tracking)
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(200),
    email VARCHAR(200) UNIQUE,
    phone VARCHAR(20),
    loyalty_points INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Staff table
CREATE TABLE staff (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(200) NOT NULL,
    role VARCHAR(50) DEFAULT 'barista',
    pin_code VARCHAR(10),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Transactions table
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_number VARCHAR(50) UNIQUE NOT NULL,
    staff_id UUID REFERENCES staff(id),
    customer_id UUID REFERENCES customers(id),
    subtotal DECIMAL(10, 2) NOT NULL DEFAULT 0,
    tax_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
    discount_amount DECIMAL(10, 2) DEFAULT 0,
    total DECIMAL(10, 2) NOT NULL DEFAULT 0,
    payment_method VARCHAR(50) DEFAULT 'cash',
    status VARCHAR(20) DEFAULT 'completed',
    order_type VARCHAR(20) DEFAULT 'dine-in',  -- 'dine-in' or 'takeout'
    source VARCHAR(20) DEFAULT 'pos',  -- 'pos' or 'simulator'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Transaction items table
CREATE TABLE transaction_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(10, 2) NOT NULL,
    discount DECIMAL(10, 2) DEFAULT 0,
    total DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_barcode ON products(barcode);
CREATE INDEX idx_transactions_staff ON transactions(staff_id);
CREATE INDEX idx_transactions_customer ON transactions(customer_id);
CREATE INDEX idx_transactions_created ON transactions(created_at);
CREATE INDEX idx_transactions_source ON transactions(source);
CREATE INDEX idx_transactions_order_type ON transactions(order_type);
CREATE INDEX idx_transaction_items_transaction ON transaction_items(transaction_id);
CREATE INDEX idx_transaction_items_product ON transaction_items(product_id);

-- Seed data: Categories
INSERT INTO categories (name, description) VALUES
('Espresso Drinks', 'Espresso-based beverages'),
('Brewed Coffee', 'Drip and pour-over coffee'),
('Tea', 'Hot and iced teas'),
('Cold Beverages', 'Iced drinks, frappes, smoothies'),
('Bagels', 'Fresh bagels with spreads'),
('Donuts', 'Glazed, filled, and specialty donuts'),
('Croissants & Pastries', 'Butter croissants and baked pastries'),
('Cakes & Desserts', 'Sliced cakes and dessert items');

-- Seed data: Products
INSERT INTO products (name, sku, barcode, category_id, price, cost, stock_quantity, unit) VALUES
-- Espresso Drinks
('Espresso', 'CAF-001', '8001', (SELECT id FROM categories WHERE name = 'Espresso Drinks'), 3.25, 0.80, 999, 'each'),
('Americano', 'CAF-002', '8002', (SELECT id FROM categories WHERE name = 'Espresso Drinks'), 3.75, 0.90, 999, 'each'),
('Latte', 'CAF-003', '8003', (SELECT id FROM categories WHERE name = 'Espresso Drinks'), 4.95, 1.20, 999, 'each'),
('Cappuccino', 'CAF-004', '8004', (SELECT id FROM categories WHERE name = 'Espresso Drinks'), 4.75, 1.10, 999, 'each'),
('Mocha', 'CAF-005', '8005', (SELECT id FROM categories WHERE name = 'Espresso Drinks'), 5.45, 1.50, 999, 'each'),
('Flat White', 'CAF-006', '8006', (SELECT id FROM categories WHERE name = 'Espresso Drinks'), 4.95, 1.20, 999, 'each'),
('Macchiato', 'CAF-007', '8007', (SELECT id FROM categories WHERE name = 'Espresso Drinks'), 4.25, 1.00, 999, 'each'),
-- Brewed Coffee
('House Blend', 'CAF-008', '8008', (SELECT id FROM categories WHERE name = 'Brewed Coffee'), 2.75, 0.50, 999, 'each'),
('Single Origin Pour-Over', 'CAF-009', '8009', (SELECT id FROM categories WHERE name = 'Brewed Coffee'), 4.50, 1.50, 999, 'each'),
('Cold Brew', 'CAF-010', '8010', (SELECT id FROM categories WHERE name = 'Brewed Coffee'), 4.25, 1.00, 999, 'each'),
-- Tea
('English Breakfast Tea', 'CAF-011', '8011', (SELECT id FROM categories WHERE name = 'Tea'), 3.25, 0.60, 999, 'each'),
('Earl Grey', 'CAF-012', '8012', (SELECT id FROM categories WHERE name = 'Tea'), 3.25, 0.60, 999, 'each'),
('Matcha Latte', 'CAF-013', '8013', (SELECT id FROM categories WHERE name = 'Tea'), 5.50, 1.80, 999, 'each'),
('Chai Latte', 'CAF-014', '8014', (SELECT id FROM categories WHERE name = 'Tea'), 4.95, 1.30, 999, 'each'),
('Green Tea', 'CAF-015', '8015', (SELECT id FROM categories WHERE name = 'Tea'), 3.00, 0.50, 999, 'each'),
-- Cold Beverages
('Iced Latte', 'CAF-016', '8016', (SELECT id FROM categories WHERE name = 'Cold Beverages'), 5.25, 1.30, 999, 'each'),
('Frappe', 'CAF-017', '8017', (SELECT id FROM categories WHERE name = 'Cold Beverages'), 5.95, 1.80, 999, 'each'),
('Iced Matcha', 'CAF-018', '8018', (SELECT id FROM categories WHERE name = 'Cold Beverages'), 5.75, 1.90, 999, 'each'),
-- Bagels
('Plain Bagel', 'CAF-019', '8019', (SELECT id FROM categories WHERE name = 'Bagels'), 2.50, 0.80, 60, 'each'),
('Everything Bagel', 'CAF-020', '8020', (SELECT id FROM categories WHERE name = 'Bagels'), 2.75, 0.90, 50, 'each'),
('Bagel with Cream Cheese', 'CAF-021', '8021', (SELECT id FROM categories WHERE name = 'Bagels'), 3.95, 1.30, 40, 'each'),
-- Donuts
('Glazed Donut', 'CAF-022', '8022', (SELECT id FROM categories WHERE name = 'Donuts'), 2.25, 0.60, 48, 'each'),
('Chocolate Donut', 'CAF-023', '8023', (SELECT id FROM categories WHERE name = 'Donuts'), 2.50, 0.70, 36, 'each'),
('Boston Cream', 'CAF-024', '8024', (SELECT id FROM categories WHERE name = 'Donuts'), 2.95, 0.90, 24, 'each'),
('Maple Bacon Donut', 'CAF-025', '8025', (SELECT id FROM categories WHERE name = 'Donuts'), 3.50, 1.10, 20, 'each'),
-- Croissants & Pastries
('Butter Croissant', 'CAF-026', '8026', (SELECT id FROM categories WHERE name = 'Croissants & Pastries'), 3.25, 1.00, 40, 'each'),
('Chocolate Croissant', 'CAF-027', '8027', (SELECT id FROM categories WHERE name = 'Croissants & Pastries'), 3.75, 1.20, 30, 'each'),
('Almond Croissant', 'CAF-028', '8028', (SELECT id FROM categories WHERE name = 'Croissants & Pastries'), 3.95, 1.30, 25, 'each'),
('Blueberry Muffin', 'CAF-029', '8029', (SELECT id FROM categories WHERE name = 'Croissants & Pastries'), 3.25, 1.00, 36, 'each'),
-- Cakes & Desserts
('NY Cheesecake Slice', 'CAF-030', '8030', (SELECT id FROM categories WHERE name = 'Cakes & Desserts'), 5.95, 2.50, 12, 'each'),
('Carrot Cake Slice', 'CAF-031', '8031', (SELECT id FROM categories WHERE name = 'Cakes & Desserts'), 5.50, 2.30, 12, 'each'),
('Tiramisu', 'CAF-032', '8032', (SELECT id FROM categories WHERE name = 'Cakes & Desserts'), 6.50, 2.80, 10, 'each');

-- Seed data: Staff
INSERT INTO staff (name, role, pin_code) VALUES
('Alex Rivera', 'barista', '1111'),
('Sam Chen', 'barista', '2222'),
('Jordan Patel', 'manager', '3333');

-- Function to update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_categories_updated_at BEFORE UPDATE ON categories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
