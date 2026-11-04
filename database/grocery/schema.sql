-- Copyright (c) 2026 Intel Corporation
--
-- SPDX-License-Identifier: Apache-2.0

-- EdgeMart Grocery Database Schema
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
    role VARCHAR(50) DEFAULT 'cashier',
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
CREATE INDEX idx_transaction_items_transaction ON transaction_items(transaction_id);
CREATE INDEX idx_transaction_items_product ON transaction_items(product_id);

-- Seed data: Categories
INSERT INTO categories (name, description) VALUES
('Produce', 'Fresh fruits and vegetables'),
('Dairy', 'Milk, cheese, yogurt, and eggs'),
('Bakery', 'Bread, pastries, and baked goods'),
('Meat & Seafood', 'Fresh and frozen meats'),
('Beverages', 'Drinks and juices'),
('Snacks', 'Chips, cookies, and candy'),
('Frozen', 'Frozen meals and desserts'),
('Household', 'Cleaning and household items');

-- Seed data: Products
INSERT INTO products (name, sku, barcode, category_id, price, cost, stock_quantity, unit) VALUES
('Banana', 'PRD-001', '4011', (SELECT id FROM categories WHERE name = 'Produce'), 0.59, 0.25, 200, 'each'),
('Apple - Gala', 'PRD-002', '4135', (SELECT id FROM categories WHERE name = 'Produce'), 1.29, 0.65, 150, 'lb'),
('Orange', 'PRD-003', '4012', (SELECT id FROM categories WHERE name = 'Produce'), 0.89, 0.40, 180, 'each'),
('Tomato', 'PRD-004', '4664', (SELECT id FROM categories WHERE name = 'Produce'), 2.49, 1.20, 100, 'lb'),
('Whole Milk 1 Gal', 'PRD-005', '0011110000101', (SELECT id FROM categories WHERE name = 'Dairy'), 3.99, 2.50, 80, 'each'),
('Cheddar Cheese', 'PRD-006', '0011110000201', (SELECT id FROM categories WHERE name = 'Dairy'), 4.49, 2.80, 60, 'each'),
('Greek Yogurt', 'PRD-007', '0011110000301', (SELECT id FROM categories WHERE name = 'Dairy'), 1.29, 0.70, 120, 'each'),
('Large Eggs (12ct)', 'PRD-008', '0011110000401', (SELECT id FROM categories WHERE name = 'Dairy'), 3.49, 2.00, 90, 'each'),
('White Bread', 'PRD-009', '0011110000501', (SELECT id FROM categories WHERE name = 'Bakery'), 2.99, 1.50, 70, 'each'),
('Croissant', 'PRD-010', '0011110000601', (SELECT id FROM categories WHERE name = 'Bakery'), 1.99, 0.90, 50, 'each'),
('Chicken Breast', 'PRD-011', '0011110000701', (SELECT id FROM categories WHERE name = 'Meat & Seafood'), 8.99, 5.50, 40, 'lb'),
('Ground Beef', 'PRD-012', '0011110000801', (SELECT id FROM categories WHERE name = 'Meat & Seafood'), 6.99, 4.00, 45, 'lb'),
('Cola 2L', 'PRD-013', '0011110000901', (SELECT id FROM categories WHERE name = 'Beverages'), 2.49, 1.20, 100, 'each'),
('Orange Juice', 'PRD-014', '0011110001001', (SELECT id FROM categories WHERE name = 'Beverages'), 4.99, 3.00, 60, 'each'),
('Bottled Water (24pk)', 'PRD-015', '0011110001101', (SELECT id FROM categories WHERE name = 'Beverages'), 5.99, 3.50, 75, 'each'),
('Potato Chips', 'PRD-016', '0011110001201', (SELECT id FROM categories WHERE name = 'Snacks'), 3.99, 2.00, 90, 'each'),
('Chocolate Bar', 'PRD-017', '0011110001301', (SELECT id FROM categories WHERE name = 'Snacks'), 1.49, 0.70, 200, 'each'),
('Frozen Pizza', 'PRD-018', '0011110001401', (SELECT id FROM categories WHERE name = 'Frozen'), 6.99, 3.50, 50, 'each'),
('Ice Cream', 'PRD-019', '0011110001501', (SELECT id FROM categories WHERE name = 'Frozen'), 5.49, 3.00, 40, 'each'),
('Paper Towels', 'PRD-020', '0011110001601', (SELECT id FROM categories WHERE name = 'Household'), 7.99, 4.50, 60, 'each');

-- Seed data: Staff
INSERT INTO staff (name, role, pin_code) VALUES
('John Smith', 'cashier', '1234'),
('Jane Doe', 'manager', '5678'),
('Bob Wilson', 'cashier', '9012');

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
