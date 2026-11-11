// BorrowHub API – standalone entry point with full CRUD routes.
// Works with `node index.js`, `npm start`, and as a Vercel serverless function.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import mongoose from 'mongoose';
import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { MongoClient, ObjectId } from 'mongodb';
import { v2 as cloudinary } from 'cloudinary';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';

// ─── Environment ────────────────────────────────────────────────────────────────
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(5000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MONGODB_URI: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  FRONTEND_URL: z.string().url(),
  COOKIE_SAME_SITE: z.enum(['strict', 'lax', 'none']).default('lax'),
  CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
  CLOUDINARY_API_KEY: z.string().min(1).optional(),
  CLOUDINARY_API_SECRET: z.string().min(1).optional(),
  UPLOAD_DIR: z.string().min(1).default('uploads'),
});
const envResult = envSchema.safeParse(process.env);
if (!envResult.success) {
  throw new Error(
    `Invalid environment configuration: ${envResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
  );
}
const env = envResult.data;

// ─── Cloudinary ─────────────────────────────────────────────────────────────────
if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

// ─── Auth (MongoDB driver + Better Auth) ────────────────────────────────────────
const authMongoClient = new MongoClient(env.MONGODB_URI);
const authDb = authMongoClient.db();

let authDatabaseReady;
let authDatabaseConnected = false;
async function connectAuthDatabase() {
  if (authDatabaseConnected) return;
  authDatabaseReady ??= authMongoClient
    .connect()
    .then(() => {
      authDatabaseConnected = true;
    })
    .catch((error) => {
      authDatabaseReady = undefined;
      throw error;
    });
  await authDatabaseReady;
}

const toMongoId = (value) => {
  try {
    return new ObjectId(value);
  } catch {
    return value;
  }
};

const auth = betterAuth({
  database: mongodbAdapter(authDb),
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [
    env.FRONTEND_URL,
    'https://borrowhub-client.vercel.app',
    'https://borrow-client.vercel.app',
    'https://borrowhub-server.vercel.app',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5000',
    'http://127.0.0.1:5000',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    (origin) => {
      if (!origin) return true;
      const clean = origin.replace(/\/$/, '');
      return (
        clean.endsWith('.vercel.app') ||
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(clean)
      );
    },
  ].filter(Boolean),
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: {
      role: { type: 'string', required: false, defaultValue: 'renter', input: false },
      phone: { type: 'string', required: false, input: true },
      location: { type: 'string', required: false, input: true },
      bio: { type: 'string', required: false, input: true },
      isVerified: { type: 'boolean', required: false, defaultValue: false, input: false },
      trustScore: { type: 'number', required: false, defaultValue: 50, input: false },
      canRent: { type: 'boolean', required: false, defaultValue: true, input: false },
      canList: { type: 'boolean', required: false, defaultValue: false, input: false },
      accountType: { type: 'string', required: false, defaultValue: 'renter', input: true },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const rawAccountType = String(user.accountType || user.role || 'renter').toLowerCase();
          const accountType = ['renter', 'owner', 'both'].includes(rawAccountType) ? rawAccountType : 'renter';
          return {
            data: {
              ...user,
              accountType,
              role: accountType === 'renter' ? 'renter' : 'owner',
              canRent: accountType !== 'owner',
              canList: accountType !== 'renter',
            },
          };
        },
      },
    },
  },
  advanced: {
    useSecureCookies: env.NODE_ENV === 'production',
    defaultCookieAttributes: {
      sameSite: env.NODE_ENV === 'production' ? 'none' : env.COOKIE_SAME_SITE,
      secure: env.NODE_ENV === 'production',
      httpOnly: true,
    },
  },
});

// ─── Payment provider (mock) ────────────────────────────────────────────────────
const paymentProvider = {
  async charge({ bookingId, amount, userId }) {
    return { reference: `mock_${bookingId}_${Date.now()}`, status: 'paid' };
  },
};

// ─── Mongoose database connection ───────────────────────────────────────────────
let dbConnection;
async function connectDatabase() {
  if (mongoose.connection.readyState === 1) return;
  if (dbConnection) return dbConnection;
  dbConnection = connectWithRetry();
  try {
    await dbConnection;
  } catch (error) {
    dbConnection = undefined;
    throw error;
  }
}
async function connectWithRetry() {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
      console.info('MongoDB connected');
      return;
    } catch (error) {
      console.error(`MongoDB connection attempt ${attempt}/5 failed`, error);
      if (attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
}

// ─── Mongoose models ────────────────────────────────────────────────────────────
const { Schema } = mongoose;
const ObjId = Schema.Types.ObjectId;

const categorySchema = new Schema(
  { slug: { type: String, unique: true, required: true }, name: { type: String, required: true }, icon: { type: String, required: true } },
  { timestamps: true },
);

const itemSchema = new Schema(
  {
    owner: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true, index: true },
    brand: String,
    model: String,
    description: { type: String, required: true },
    phone: { type: String, trim: true, default: '' },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    includes: [String],
    images: [String],
    condition: { type: String, enum: ['New', 'Like New', 'Excellent', 'Good', 'Fair'], required: true },
    pricing: { daily: { type: Number, required: true }, weekly: { type: Number, required: true }, monthly: { type: Number, required: true } },
    deposit: { type: Number, default: 0 },
    location: {
      area: String,
      city: String,
      coordinates: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], default: [0, 0] },
      },
    },
    pickupOption: { type: String, enum: ['owner_pickup', 'delivery', 'both'], default: 'both' },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'paused'], default: 'approved', index: true },
    avgRating: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    totalBookings: { type: Number, default: 0 },
    isFeatured: { type: Boolean, default: false, index: true },
    featuredOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);
itemSchema.index({ name: 'text', brand: 'text', description: 'text' });
itemSchema.index({ 'location.coordinates': '2dsphere' });

const bookingSchema = new Schema(
  {
    item: { type: ObjId, ref: 'Item', required: true },
    renter: { type: String, required: true, index: true },
    owner: { type: String, required: true, index: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    days: { type: Number, required: true },
    pricing: { rate: Number, rentalTotal: Number, serviceFee: Number, deposit: Number, grandTotal: Number },
    status: {
      type: String,
      enum: ['requested', 'approved', 'paid', 'picked_up', 'active', 'returned', 'completed', 'rejected', 'cancelled', 'disputed'],
      default: 'requested',
      index: true,
    },
    statusHistory: [{ status: String, actor: String, at: { type: Date, default: Date.now }, note: String }],
    renterMessage: String,
    beforePhotos: [String],
    afterPhotos: [String],
  },
  { timestamps: true },
);
bookingSchema.index({ item: 1, startDate: 1, endDate: 1, status: 1 });

const reviewSchema = new Schema(
  {
    booking: { type: ObjId, ref: 'Booking', required: true },
    item: { type: ObjId, ref: 'Item', required: true },
    reviewer: { type: String, required: true },
    reviewee: { type: String, required: true },
    rating: { type: Number, min: 1, max: 5, required: true },
    comment: String,
  },
  { timestamps: true },
);
reviewSchema.index({ booking: 1, reviewer: 1 }, { unique: true });

const favoriteSchema = new Schema(
  { user: { type: String, required: true }, item: { type: ObjId, ref: 'Item', required: true } },
  { timestamps: true },
);
favoriteSchema.index({ user: 1, item: 1 }, { unique: true });

const conversationSchema = new Schema(
  {
    participants: { type: [String], required: true },
    item: { type: ObjId, ref: 'Item' },
    lastMessage: String,
    unreadCounts: { type: Map, of: Number, default: {} },
  },
  { timestamps: true },
);

const messageSchema = new Schema(
  {
    conversation: { type: ObjId, ref: 'Conversation', required: true, index: true },
    sender: { type: String, required: true },
    text: { type: String, required: true, maxlength: 5000 },
    readAt: Date,
  },
  { timestamps: true },
);

const disputeSchema = new Schema(
  {
    booking: { type: ObjId, ref: 'Booking', required: true },
    openedBy: { type: String, required: true },
    reason: { type: String, required: true },
    severity: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    status: { type: String, enum: ['open', 'investigating', 'resolved'], default: 'open' },
    evidence: [String],
    resolutionNote: String,
  },
  { timestamps: true },
);

const verificationSchema = new Schema(
  {
    user: { type: String, required: true },
    type: { type: String, enum: ['identity', 'phone', 'owner'], required: true },
    documents: [String],
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  },
  { timestamps: true },
);

const registered = (name) => mongoose.models[name];
const Category = registered('Category') ?? mongoose.model('Category', categorySchema);
const Item = registered('Item') ?? mongoose.model('Item', itemSchema);
const Booking = registered('Booking') ?? mongoose.model('Booking', bookingSchema);
const Review = registered('Review') ?? mongoose.model('Review', reviewSchema);
const Favorite = registered('Favorite') ?? mongoose.model('Favorite', favoriteSchema);
const Conversation = registered('Conversation') ?? mongoose.model('Conversation', conversationSchema);
const Message = registered('Message') ?? mongoose.model('Message', messageSchema);
const Dispute = registered('Dispute') ?? mongoose.model('Dispute', disputeSchema);
const VerificationRequest = registered('VerificationRequest') ?? mongoose.model('VerificationRequest', verificationSchema);

// ─── Errors & helpers ───────────────────────────────────────────────────────────
class AppError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.name = 'AppError';
  }
}

const asyncHandler = (fn) => (req, res, next) => {
  void fn(req, res, next).catch(next);
};

function send(res, data, message = 'OK', status = 200, meta) {
  res.status(status).json({ success: true, data, message, ...(meta ? { meta } : {}) });
}

const errorHandler = (error, _req, res, _next) => {
  if (error instanceof AppError) return res.status(error.statusCode).json({ success: false, message: error.message, ...(error.details !== undefined ? { errors: error.details } : {}) });
  if (error?.name === 'ZodError') return res.status(400).json({ success: false, message: 'Validation failed', errors: error.flatten() });
  if (error instanceof mongoose.Error.ValidationError) return res.status(400).json({ success: false, message: 'Validation failed', errors: Object.fromEntries(Object.entries(error.errors).map(([f, i]) => [f, i.message])) });
  if (error instanceof mongoose.Error.CastError) return res.status(400).json({ success: false, message: `Invalid value for ${error.path}` });
  if (error?.name === 'MulterError') return res.status(400).json({ success: false, message: error.message });
  if (error?.code === 11000) return res.status(409).json({ success: false, message: 'Duplicate entry' });
  console.error('Unhandled request error:', error);
  res.status(500).json({ success: false, message: 'Internal server error' });
};

// ─── Auth middleware ────────────────────────────────────────────────────────────
const requireAuth = asyncHandler(async (req, _res, next) => {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) throw new AppError(401, 'Authentication required');
  req.user = session.user;
  next();
});

const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return next(new AppError(403, 'Insufficient permissions'));
    next();
  };

// ─── Route utilities ────────────────────────────────────────────────────────────
const wrap = (fn) => asyncHandler(async (req, res) => { await fn(req, res); });

const id = (value) => {
  if (Array.isArray(value) || !/^[a-f\d]{24}$/i.test(value)) throw new AppError(400, 'Invalid id');
  return value;
};

const pageOf = (req) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
};

const plainCounts = (value) => {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value && typeof value === 'object') return value;
  return {};
};

const unreadOf = (conversation, userId) => plainCounts(conversation.unreadCounts)[userId] ?? 0;

const activeStatuses = ['approved', 'paid', 'picked_up', 'active', 'returned'];

const priceForDays = (days, pricing) => {
  const costs = Array.from({ length: days + 1 }, () => Number.POSITIVE_INFINITY);
  costs[0] = 0;
  for (let n = 1; n <= days; n += 1) {
    costs[n] = Math.min(
      costs[n - 1] + pricing.daily,
      n >= 7 ? costs[n - 7] + pricing.weekly : Number.POSITIVE_INFINITY,
      n >= 30 ? costs[n - 30] + pricing.monthly : Number.POSITIVE_INFINITY,
    );
  }
  return costs[days];
};

// ─── Express app ────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: false,
    contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false,
  }),
);

const allowedOrigins = [
  env.FRONTEND_URL,
  'https://borrowhub-client.vercel.app',
  'https://borrow-client.vercel.app',
  'https://borrowhub-server.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5000',
  'http://127.0.0.1:5000',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const cleanOrigin = origin.replace(/\/$/, '');
      if (
        allowedOrigins.includes(cleanOrigin) ||
        cleanOrigin.endsWith('.vercel.app') ||
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cleanOrigin)
      ) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    credentials: true,
  }),
);
app.use(compression());
app.use(morgan('combined'));

// Connect databases on /api requests
app.use(
  '/api',
  asyncHandler(async (_req, _res, next) => {
    await Promise.all([connectDatabase(), connectAuthDatabase()]);
    next();
  }),
);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100 });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60 });

// ─── Auth routes ────────────────────────────────────────────────────────────────
app.use('/api/auth', authLimiter);
app.all('/api/auth/*splat', toNodeHandler(auth));
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(path.join(process.cwd(), env.UPLOAD_DIR), { maxAge: '1h' }));

// ─── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => send(res, { status: 'ok' }, 'Healthy'));
app.get('/api/health', (_req, res) => send(res, { status: 'ok' }, 'Healthy'));

// ═══════════════════════════════════════════════════════════════════════════════
//  USER PROFILE  (Read / Update)
// ═══════════════════════════════════════════════════════════════════════════════

// READ – get current user
app.get('/api/me', requireAuth, wrap(async (req, res) => {
  send(res, req.user);
}));

// UPDATE – patch current user profile
app.patch('/api/me', requireAuth, wrap(async (req, res) => {
  const allowed = z
    .object({
      name: z.string().min(1).max(100).optional(),
      phone: z.string().max(30).optional(),
      location: z.string().max(200).optional(),
      bio: z.string().max(1000).optional(),
      canRent: z.boolean().optional(),
      canList: z.boolean().optional(),
    })
    .strict()
    .parse(req.body);

  const user = await authMongoClient
    .db()
    .collection('user')
    .findOneAndUpdate(
      { _id: toMongoId(req.user.id) },
      { $set: allowed },
      { returnDocument: 'after', projection: { password: 0 } },
    );
  if (!user) throw new AppError(404, 'User not found');
  send(res, user);
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  CATEGORIES  (Read)
// ═══════════════════════════════════════════════════════════════════════════════

// READ – list all categories
app.get('/api/categories', wrap(async (_req, res) => {
  send(res, await Category.find().lean());
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  ITEMS  (full CRUD)
// ═══════════════════════════════════════════════════════════════════════════════

const itemInput = z.object({
  name: z.string().min(3).max(120),
  category: z.string(),
  brand: z.string().max(80).optional(),
  model: z.string().max(80).optional(),
  description: z.string().min(10).max(5000),
  phone: z.string().max(30).optional().default(''),
  quantity: z.number().int().min(1).optional().default(1),
  includes: z.array(z.string()).max(30).default([]),
  images: z.array(z.string().url()).max(8).default([]),
  condition: z.enum(['New', 'Like New', 'Excellent', 'Good', 'Fair']),
  pricing: z.object({ daily: z.number().positive(), weekly: z.number().positive(), monthly: z.number().positive() }),
  deposit: z.number().min(0).default(0),
  location: z.object({
    area: z.string(),
    city: z.string(),
    coordinates: z.object({
      type: z.literal('Point').default('Point'),
      coordinates: z.tuple([z.number(), z.number()]),
    }),
  }),
  pickupOption: z.enum(['owner_pickup', 'delivery', 'both']).default('both'),
});

// READ – list / search / filter items (paginated)
app.get('/api/items', wrap(async (req, res) => {
  const { page, limit, skip } = pageOf(req);
  const query = { status: 'approved' };

  if (req.query.q) query.$text = { $search: String(req.query.q).slice(0, 100) };
  if (req.query.category) query.category = req.query.category;
  if (req.query.condition) query.condition = req.query.condition;
  if (req.query.area) query['location.area'] = new RegExp(String(req.query.area).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  if (req.query.minRating) query.avgRating = { $gte: Number(req.query.minRating) };

  const min = Number(req.query.minPrice);
  const max = Number(req.query.maxPrice);
  if (min || max) query['pricing.daily'] = { ...(min ? { $gte: min } : {}), ...(max ? { $lte: max } : {}) };

  if (req.query.startDate && req.query.endDate) {
    const unavailable = await Booking.distinct('item', {
      status: { $in: activeStatuses },
      startDate: { $lt: new Date(String(req.query.endDate)) },
      endDate: { $gt: new Date(String(req.query.startDate)) },
    });
    query._id = { $nin: unavailable };
  }

  const sort =
    req.query.sort === 'price_asc' ? { 'pricing.daily': 1 }
    : req.query.sort === 'price_desc' ? { 'pricing.daily': -1 }
    : req.query.sort === 'rating' ? { avgRating: -1 }
    : req.query.sort === 'newest' ? { createdAt: -1 }
    : { createdAt: -1, totalBookings: -1, avgRating: -1 };

  const [items, total] = await Promise.all([
    Item.find(query).sort(sort).skip(skip).limit(limit).lean(),
    Item.countDocuments(query),
  ]);

  send(res, items, 'Items', 200, { page, limit, total, pages: Math.ceil(total / limit) });
}));

// READ – homepage featured items
app.get('/api/items/featured', wrap(async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
  const items = await Item.find({ status: 'approved', isFeatured: true })
    .sort({ featuredOrder: -1, avgRating: -1, totalBookings: -1 })
    .limit(limit)
    .lean();
  send(res, items, 'Featured items');
}));

// READ – get single item with owner info & booked dates
app.get('/api/items/:id', wrap(async (req, res) => {
  const item = await Item.findById(id(req.params.id)).lean();
  if (!item) throw new AppError(404, 'Item not found');

  const [owner, bookedDates] = await Promise.all([
    authMongoClient
      .db()
      .collection('user')
      .findOne({ _id: toMongoId(item.owner) }, { projection: { name: 1, image: 1, location: 1, bio: 1, trustScore: 1, isVerified: 1, phone: 1 } }),
    Booking.find({ item: item._id, status: { $in: activeStatuses } }, { startDate: 1, endDate: 1 }).lean(),
  ]);

  const phone = item.phone || owner?.phone || '';
  send(res, { ...item, phone, owner: { ...owner, phone }, bookedDates });
}));

// READ – item availability for a given month
app.get('/api/items/:id/availability', wrap(async (req, res) => {
  const itemId = id(req.params.id);
  const month = String(req.query.month ?? '');
  if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError(400, 'month must be YYYY-MM');

  const start = new Date(`${month}-01T00:00:00Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));

  send(
    res,
    await Booking.find(
      { item: itemId, status: { $in: activeStatuses }, startDate: { $lt: end }, endDate: { $gt: start } },
      { startDate: 1, endDate: 1 },
    ).lean(),
  );
}));

// READ – reviews for an item (paginated)
app.get('/api/items/:id/reviews', wrap(async (req, res) => {
  const { page, limit, skip } = pageOf(req);
  const filter = { item: id(req.params.id) };
  const [rows, total] = await Promise.all([
    Review.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Review.countDocuments(filter),
  ]);
  send(res, rows, 'Reviews', 200, { page, limit, total });
}));

// CREATE – create a new item listing
app.post('/api/items', requireAuth, writeLimiter, wrap(async (req, res) => {
  const data = itemInput.parse(req.body);
  const item = await Item.create({ ...data, owner: req.user.id, status: 'approved' });
  send(res, item, 'Listing created', 201);
}));

// UPDATE – update an existing item listing
app.patch('/api/items/:id', requireAuth, writeLimiter, wrap(async (req, res) => {
  const item = await Item.findById(id(req.params.id));
  if (!item) throw new AppError(404, 'Item not found');
  if (item.owner !== req.user.id && req.user.role !== 'admin') throw new AppError(403, 'Not your listing');

  const data = itemInput.partial().parse(req.body);
  Object.assign(item, data);
  item.status = 'pending';
  await item.save();
  send(res, item);
}));

// DELETE – delete an item listing
app.delete('/api/items/:id', requireAuth, writeLimiter, wrap(async (req, res) => {
  const item = await Item.findById(id(req.params.id));
  if (!item) throw new AppError(404, 'Item not found');
  if (item.owner !== req.user.id && req.user.role !== 'admin') throw new AppError(403, 'Not your listing');

  await item.deleteOne();
  send(res, { deleted: true });
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  IMAGE UPLOADS
// ═══════════════════════════════════════════════════════════════════════════════

app.post(
  '/api/uploads/images',
  requireAuth,
  writeLimiter,
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 8 },
    fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
  }).array('images', 8),
  wrap(async (req, res) => {
    const files = req.files;
    if (!files?.length) throw new AppError(400, 'Upload at least one image');

    const results = await Promise.all(
      files.map(
        (file) =>
          new Promise((resolve, reject) => {
            const ext = path.extname(file.originalname).toLowerCase();
            const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
            const dir = path.resolve(process.cwd(), env.UPLOAD_DIR);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, filename), file.buffer);
            const base = `${req.protocol}://${req.get('host') ?? `localhost:${env.PORT}`}`;
            resolve(`${base}/uploads/${filename}`);
          }),
      ),
    );
    send(res, results, 'Images uploaded', 201);
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
//  OWNER PROFILES  (Read)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/owners/:id', wrap(async (req, res) => {
  const ownerId = id(req.params.id);
  const [user, items, reviews] = await Promise.all([
    authMongoClient
      .db()
      .collection('user')
      .findOne({ _id: toMongoId(ownerId) }, { projection: { name: 1, image: 1, location: 1, bio: 1, trustScore: 1, isVerified: 1, createdAt: 1, phone: 1 } }),
    Item.find({ owner: ownerId, status: 'approved' }).limit(50).lean(),
    Review.find({ reviewee: ownerId }).sort({ createdAt: -1 }).limit(30).lean(),
  ]);
  if (!user) throw new AppError(404, 'Owner not found');
  send(res, { user, items, reviews, trustScoreBreakdown: { score: user.trustScore ?? 50 } });
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  BOOKINGS  (full CRUD)
// ═══════════════════════════════════════════════════════════════════════════════

const bookingInput = z.object({
  itemId: z.string(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  renterMessage: z.string().max(1000).optional(),
});

const quote = async (input) => {
  const item = await Item.findById(id(input.itemId));
  if (!item) throw new AppError(404, 'Item not found');

  const days = Math.ceil((input.endDate.getTime() - input.startDate.getTime()) / 86400000);
  if (days < 1 || days > 365) throw new AppError(400, 'Invalid rental dates');
  if (!item.pricing) throw new AppError(400, 'Listing pricing unavailable');

  const rentalTotal = priceForDays(days, item.pricing);
  const serviceFee = Math.round(rentalTotal * 0.05);
  return {
    item,
    days,
    pricing: {
      rate: rentalTotal / days,
      rentalTotal,
      serviceFee,
      deposit: item.deposit ?? 0,
      grandTotal: rentalTotal + serviceFee + (item.deposit ?? 0),
    },
  };
};

// READ – get a price quote
app.post('/api/bookings/quote', requireAuth, wrap(async (req, res) => {
  const data = bookingInput.parse(req.body);
  const result = await quote(data);
  send(res, { days: result.days, pricing: result.pricing });
}));

// CREATE – create a new booking
app.post('/api/bookings', requireAuth, writeLimiter, wrap(async (req, res) => {
  const data = bookingInput.parse(req.body);
  const session = await mongoose.startSession();

  try {
    let created;
    await session.withTransaction(async () => {
      const result = await quote(data);
      if (result.item.status !== 'approved') throw new AppError(400, 'Listing is not available');
      if (result.item.owner === req.user.id) throw new AppError(400, 'Cannot book your own item');

      const conflict = await Booking.exists({
        item: result.item._id,
        status: { $in: activeStatuses },
        startDate: { $lt: data.endDate },
        endDate: { $gt: data.startDate },
      }).session(session);
      if (conflict) throw new AppError(409, 'Dates are unavailable');

      const docs = await Booking.create(
        [
          {
            item: result.item._id,
            renter: req.user.id,
            owner: result.item.owner,
            startDate: data.startDate,
            endDate: data.endDate,
            days: result.days,
            pricing: result.pricing,
            renterMessage: data.renterMessage,
            statusHistory: [{ status: 'requested', actor: req.user.id }],
          },
        ],
        { session },
      );
      created = docs[0];
    });
    send(res, created, 'Booking requested', 201);
  } finally {
    await session.endSession();
  }
}));

// READ – list my bookings (paginated)
app.get('/api/bookings/mine', requireAuth, wrap(async (req, res) => {
  const role = req.query.role === 'owner' ? 'owner' : 'renter';
  const { page, limit, skip } = pageOf(req);
  const filter = role === 'owner' ? { owner: req.user.id } : { renter: req.user.id };

  const [rows, total] = await Promise.all([
    Booking.find(filter).populate('item').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Booking.countDocuments(filter),
  ]);
  send(res, rows, 'Bookings', 200, { page, limit, total, pages: Math.ceil(total / limit) });
}));

// READ – get single booking
app.get('/api/bookings/:id', requireAuth, wrap(async (req, res) => {
  const booking = await Booking.findById(id(req.params.id)).populate('item').lean();
  if (!booking) throw new AppError(404, 'Booking not found');
  if (booking.renter !== req.user.id && booking.owner !== req.user.id && req.user.role !== 'admin')
    throw new AppError(403, 'Not a participant');
  send(res, booking);
}));

// UPDATE – change booking status (approve/reject/pay/pickup/return/complete/cancel)
app.patch('/api/bookings/:id/status', requireAuth, writeLimiter, wrap(async (req, res) => {
  const { action } = z
    .object({ action: z.enum(['approve', 'reject', 'pay', 'pickup', 'return', 'complete', 'cancel']) })
    .parse(req.body);

  const booking = await Booking.findById(id(req.params.id));
  if (!booking) throw new AppError(404, 'Booking not found');

  const actor = req.user.id;
  const flow = {
    approve: { from: ['requested'], to: 'approved', role: 'owner' },
    reject: { from: ['requested'], to: 'rejected', role: 'owner' },
    pay: { from: ['approved'], to: 'paid', role: 'renter' },
    pickup: { from: ['paid'], to: 'picked_up', role: 'owner' },
    return: { from: ['picked_up', 'active'], to: 'returned', role: 'renter' },
    complete: { from: ['returned'], to: 'completed', role: 'owner' },
    cancel: { from: ['requested', 'approved'], to: 'cancelled', role: 'either' },
  };

  const step = flow[action];
  const isOwner = booking.owner === actor;
  const isRenter = booking.renter === actor;

  if ((step.role === 'owner' && !isOwner) || (step.role === 'renter' && !isRenter) || (!isOwner && !isRenter))
    throw new AppError(403, 'Not permitted');

  const current = booking.status ?? 'requested';
  if (!step.from.includes(current)) throw new AppError(400, `Cannot ${action} a ${current} booking`);

  if (action === 'pay')
    await paymentProvider.charge({ bookingId: String(booking._id), amount: booking.pricing?.grandTotal ?? 0, userId: actor });

  booking.status = step.to;
  booking.statusHistory.push({ status: step.to, actor, at: new Date() });
  await booking.save();

  if (action === 'complete') await Item.updateOne({ _id: booking.item }, { $inc: { totalBookings: 1 } });

  send(res, booking);
}));

// CREATE – add before/after photos to a booking
app.post('/api/bookings/:id/photos', requireAuth, wrap(async (req, res) => {
  const data = z
    .object({ stage: z.enum(['before', 'after']), urls: z.array(z.string().url()).min(1).max(8) })
    .parse(req.body);

  const booking = await Booking.findById(id(req.params.id));
  if (!booking) throw new AppError(404, 'Booking not found');
  if (booking.renter !== req.user.id && booking.owner !== req.user.id) throw new AppError(403, 'Not a participant');

  if (data.stage === 'before') booking.beforePhotos.push(...data.urls);
  else booking.afterPhotos.push(...data.urls);

  await booking.save();
  send(res, booking);
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  REVIEWS  (Create / Read)
// ═══════════════════════════════════════════════════════════════════════════════

// CREATE – leave a review after a completed booking
app.post('/api/reviews', requireAuth, wrap(async (req, res) => {
  const data = z
    .object({ bookingId: z.string(), rating: z.number().int().min(1).max(5), comment: z.string().max(2000).optional() })
    .parse(req.body);

  const booking = await Booking.findById(id(data.bookingId));
  if (!booking || booking.status !== 'completed') throw new AppError(400, 'Review requires a completed booking');

  const reviewee =
    booking.renter === req.user.id ? booking.owner : booking.owner === req.user.id ? booking.renter : '';
  if (!reviewee) throw new AppError(403, 'Only participants can review');

  const review = await Review.create({
    booking: booking._id,
    item: booking.item,
    reviewer: req.user.id,
    reviewee,
    rating: data.rating,
    comment: data.comment,
  });

  // Recalculate item rating
  const [agg] = await Review.aggregate([
    { $match: { item: booking.item } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  await Item.updateOne({ _id: booking.item }, { $set: { avgRating: agg?.avg ?? 0, reviewCount: agg?.count ?? 0 } });

  send(res, review, 'Review created', 201);
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  FAVORITES  (full CRUD)
// ═══════════════════════════════════════════════════════════════════════════════

// READ – list favorites (paginated)
app.get('/api/favorites', requireAuth, wrap(async (req, res) => {
  const { page, limit, skip } = pageOf(req);
  const rows = await Favorite.find({ user: req.user.id }).populate('item').skip(skip).limit(limit).lean();
  send(res, rows);
}));

// CREATE / DELETE – toggle a favorite
app.post('/api/favorites/:itemId', requireAuth, wrap(async (req, res) => {
  const itemId = id(req.params.itemId);
  const old = await Favorite.findOne({ user: req.user.id, item: itemId });
  if (old) {
    await old.deleteOne();
    send(res, { favorited: false });
  } else {
    await Favorite.create({ user: req.user.id, item: itemId });
    send(res, { favorited: true }, 'Added to favorites', 201);
  }
}));

// DELETE – remove a favorite explicitly
app.delete('/api/favorites/:itemId', requireAuth, wrap(async (req, res) => {
  await Favorite.deleteOne({ user: req.user.id, item: id(req.params.itemId) });
  send(res, { deleted: true });
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  CONVERSATIONS & MESSAGES  (CRUD)
// ═══════════════════════════════════════════════════════════════════════════════

// READ – list conversations
app.get('/api/conversations', requireAuth, wrap(async (req, res) => {
  const rows = await Conversation.find({ participants: req.user.id }).sort({ updatedAt: -1 }).lean();
  send(res, rows.map((row) => ({ ...row, unreadCounts: plainCounts(row.unreadCounts) })));
}));

// CREATE – start or find a conversation
app.post('/api/conversations', requireAuth, wrap(async (req, res) => {
  const data = z.object({ ownerId: z.string(), itemId: z.string().optional() }).parse(req.body);
  if (data.ownerId === req.user.id) throw new AppError(400, 'Cannot message yourself');

  const filter = {
    participants: { $all: [req.user.id, data.ownerId] },
    ...(data.itemId ? { item: id(data.itemId) } : {}),
  };
  const conversation = await Conversation.findOneAndUpdate(
    filter,
    { $setOnInsert: { participants: [req.user.id, data.ownerId], ...(data.itemId ? { item: data.itemId } : {}) } },
    { upsert: true, new: true },
  );
  send(res, conversation, 'Conversation ready', 201);
}));

// READ – list messages in a conversation (paginated)
app.get('/api/conversations/:id/messages', requireAuth, wrap(async (req, res) => {
  const conversation = await Conversation.findById(id(req.params.id));
  if (!conversation || !conversation.participants.includes(req.user.id))
    throw new AppError(404, 'Conversation not found');

  const { page, limit, skip } = pageOf(req);
  const [rows, total] = await Promise.all([
    Message.find({ conversation: conversation._id }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Message.countDocuments({ conversation: conversation._id }),
  ]);
  send(res, rows.reverse(), 'Messages', 200, { page, limit, total });
}));

// CREATE – send a message
app.post('/api/conversations/:id/messages', requireAuth, writeLimiter, wrap(async (req, res) => {
  const conversation = await Conversation.findById(id(req.params.id));
  if (!conversation || !conversation.participants.includes(req.user.id))
    throw new AppError(404, 'Conversation not found');

  const { text: body } = z.object({ text: z.string().trim().min(1).max(5000) }).parse(req.body);

  const message = await Message.create({ conversation: conversation._id, sender: req.user.id, text: body });

  conversation.lastMessage = body;
  for (const participant of conversation.participants) {
    if (participant !== req.user.id) {
      conversation.unreadCounts.set(participant, (conversation.unreadCounts.get(participant) ?? 0) + 1);
    }
  }
  await conversation.save();

  send(res, message, 'Message sent', 201);
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  DASHBOARDS  (Read)
// ═══════════════════════════════════════════════════════════════════════════════

// Renter dashboard
app.get('/api/dashboard/renter', requireAuth, wrap(async (req, res) => {
  const [active, completed, favorites, conversations] = await Promise.all([
    Booking.countDocuments({ renter: req.user.id, status: { $in: ['paid', 'picked_up', 'active', 'returned'] } }),
    Booking.countDocuments({ renter: req.user.id, status: 'completed' }),
    Favorite.countDocuments({ user: req.user.id }),
    Conversation.find({ participants: req.user.id }).lean(),
  ]);
  const unread = conversations.reduce((sum, c) => sum + unreadOf(c, req.user.id), 0);
  send(res, { active, completed, favorites, unread });
}));

// Owner dashboard
app.get('/api/dashboard/owner', requireAuth, wrap(async (req, res) => {
  const [bookings, listings, active, pending] = await Promise.all([
    Booking.find({ owner: req.user.id }).populate('item').sort({ createdAt: -1 }).limit(10).lean(),
    Item.countDocuments({ owner: req.user.id }),
    Booking.countDocuments({ owner: req.user.id, status: { $in: ['paid', 'picked_up', 'active'] } }),
    Booking.aggregate([
      { $match: { owner: req.user.id, status: { $in: ['paid', 'picked_up', 'active', 'returned', 'completed'] } } },
      { $group: { _id: null, total: { $sum: '$pricing.rentalTotal' } } },
    ]),
  ]);
  send(res, {
    totalEarnings: pending[0]?.total ?? 0,
    thisMonth: 0,
    pendingPayout: 0,
    activeRentals: active,
    listings,
    trustScore: req.user.trustScore ?? 50,
    monthlyRevenue: [],
    topItems: [],
    recentBookings: bookings,
  });
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  DISPUTES  (Create)
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/disputes', requireAuth, wrap(async (req, res) => {
  const data = z
    .object({
      bookingId: z.string(),
      reason: z.string().min(10).max(3000),
      severity: z.enum(['low', 'medium', 'high']).default('medium'),
      evidence: z.array(z.string().url()).max(10).default([]),
    })
    .parse(req.body);

  const booking = await Booking.findById(id(data.bookingId));
  if (!booking || (booking.renter !== req.user.id && booking.owner !== req.user.id))
    throw new AppError(403, 'Booking participant required');

  booking.status = 'disputed';
  booking.statusHistory.push({ status: 'disputed', actor: req.user.id, at: new Date() });
  await booking.save();

  send(res, await Dispute.create({ booking: booking._id, openedBy: req.user.id, ...data }), 'Dispute opened', 201);
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN  (full CRUD)
// ═══════════════════════════════════════════════════════════════════════════════

const adminOnly = [requireAuth, requireRole('admin')];

// READ – admin stats
app.get('/api/admin/stats', ...adminOnly, wrap(async (_req, res) => {
  const [users, items, bookings, disputes] = await Promise.all([
    authMongoClient.db().collection('user').countDocuments(),
    Item.countDocuments(),
    Booking.countDocuments(),
    Dispute.countDocuments({ status: { $ne: 'resolved' } }),
  ]);
  send(res, { users, items, bookings, openDisputes: disputes });
}));

// READ – list users (paginated)
app.get('/api/admin/users', ...adminOnly, wrap(async (req, res) => {
  const { page, limit, skip } = pageOf(req);
  const col = authMongoClient.db().collection('user');
  const [rows, total] = await Promise.all([
    col.find({}, { projection: { password: 0 } }).skip(skip).limit(limit).toArray(),
    col.countDocuments(),
  ]);
  send(res, rows, 'Users', 200, { page, limit, total });
}));

// UPDATE – update a user (admin)
app.patch('/api/admin/users/:id', ...adminOnly, wrap(async (req, res) => {
  const data = z
    .object({
      role: z.enum(['renter', 'owner', 'admin']).optional(),
      isVerified: z.boolean().optional(),
      trustScore: z.number().min(0).max(100).optional(),
      banned: z.boolean().optional(),
    })
    .strict()
    .parse(req.body);

  const col = authMongoClient.db().collection('user');
  const user = await col.findOneAndUpdate(
    { _id: toMongoId(id(req.params.id)) },
    { $set: data },
    { returnDocument: 'after', projection: { password: 0 } },
  );
  if (!user) throw new AppError(404, 'User not found');
  send(res, user);
}));

// READ – list items (admin, paginated)
app.get('/api/admin/items', ...adminOnly, wrap(async (req, res) => {
  const { page, limit, skip } = pageOf(req);
  const filter = req.query.status ? { status: String(req.query.status) } : {};
  const [rows, total] = await Promise.all([
    Item.find(filter).skip(skip).limit(limit).lean(),
    Item.countDocuments(filter),
  ]);
  send(res, rows, 'Items', 200, { page, limit, total });
}));

// UPDATE – approve/reject/pause an item (admin)
app.patch('/api/admin/items/:id', ...adminOnly, wrap(async (req, res) => {
  const { status } = z.object({ status: z.enum(['approved', 'rejected', 'paused']) }).parse(req.body);
  const item = await Item.findByIdAndUpdate(id(req.params.id), { status }, { new: true });
  if (!item) throw new AppError(404, 'Item not found');
  send(res, item);
}));

// UPDATE – toggle homepage featured status (admin)
app.patch('/api/admin/items/:id/feature', ...adminOnly, wrap(async (req, res) => {
  const data = z.object({ isFeatured: z.boolean(), featuredOrder: z.number().int().min(-9999).max(9999).default(0) }).strict().parse(req.body);
  const item = await Item.findByIdAndUpdate(id(req.params.id), { $set: { isFeatured: data.isFeatured, featuredOrder: data.featuredOrder } }, { new: true });
  if (!item) throw new AppError(404, 'Item not found');
  send(res, item, 'Feature status updated');
}));

// READ – list bookings (admin, paginated)
app.get('/api/admin/bookings', ...adminOnly, wrap(async (req, res) => {
  const { page, limit, skip } = pageOf(req);
  const [rows, total] = await Promise.all([
    Booking.find().populate('item').skip(skip).limit(limit).lean(),
    Booking.countDocuments(),
  ]);
  send(res, rows, 'Bookings', 200, { page, limit, total });
}));

// READ – list disputes (admin)
app.get('/api/admin/disputes', ...adminOnly, wrap(async (_req, res) => {
  send(res, await Dispute.find().populate('booking').sort({ createdAt: -1 }).limit(100).lean());
}));

// UPDATE – update dispute status (admin)
app.patch('/api/admin/disputes/:id', ...adminOnly, wrap(async (req, res) => {
  const data = z
    .object({ status: z.enum(['open', 'investigating', 'resolved']), resolutionNote: z.string().max(3000).optional() })
    .parse(req.body);

  const row = await Dispute.findByIdAndUpdate(id(req.params.id), data, { new: true });
  if (!row) throw new AppError(404, 'Dispute not found');
  send(res, row);
}));

// READ – list verifications (admin)
app.get('/api/admin/verifications', ...adminOnly, wrap(async (_req, res) => {
  send(res, await VerificationRequest.find().sort({ createdAt: -1 }).limit(100).lean());
}));

// UPDATE – approve/reject verification (admin)
app.patch('/api/admin/verifications/:id', ...adminOnly, wrap(async (req, res) => {
  const { status } = z.object({ status: z.enum(['approved', 'rejected']) }).parse(req.body);
  const row = await VerificationRequest.findByIdAndUpdate(id(req.params.id), { status }, { new: true });
  if (!row) throw new AppError(404, 'Verification not found');
  send(res, row);
}));

// ─── 404 & error handler ────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found' }));
app.use(errorHandler);

// ─── HTTP + Socket.io server ────────────────────────────────────────────────────
const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

io.use(async (socket, next) => {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(socket.request.headers) });
    if (!session) return next(new Error('Unauthorized'));
    socket.data.userId = session.user.id;
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.on('conversation:join', async (conversationId) => {
    const conversation = await Conversation.findById(conversationId);
    if (conversation?.participants.includes(String(socket.data.userId))) socket.join(conversationId);
  });

  socket.on('message:send', async (payload) => {
    const conversation = await Conversation.findById(payload.conversationId);
    if (!conversation?.participants.includes(String(socket.data.userId)) || !payload.text?.trim()) return;

    const message = await Message.create({
      conversation: conversation._id,
      sender: String(socket.data.userId),
      text: payload.text.trim().slice(0, 5000),
    });

    conversation.lastMessage = message.text;
    for (const participant of conversation.participants) {
      if (participant !== String(socket.data.userId)) {
        conversation.unreadCounts.set(participant, (conversation.unreadCounts.get(participant) ?? 0) + 1);
      }
    }
    await conversation.save();
    io.to(String(conversation._id)).emit('message:new', message);
  });

  socket.on('message:read', async (payload) => {
    const conversation = await Conversation.findById(payload.conversationId);
    if (!conversation?.participants.includes(String(socket.data.userId))) return;

    const filter = {
      conversation: conversation._id,
      sender: { $ne: String(socket.data.userId) },
      readAt: { $exists: false },
      ...(payload.messageId ? { _id: payload.messageId } : {}),
    };
    await Message.updateMany(filter, { $set: { readAt: new Date() } });
    conversation.unreadCounts.set(String(socket.data.userId), 0);
    await conversation.save();
    io.to(String(conversation._id)).emit('message:read', {
      conversationId: payload.conversationId,
      userId: String(socket.data.userId),
    });
  });
});

// ─── Start server (skip on Vercel) ──────────────────────────────────────────────
if (process.env.VERCEL !== '1') {
  httpServer.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`MongoDB connected, but port ${env.PORT} is already in use. Stop the other BorrowHub server or change PORT in .env.`);
      io.close(() => { void mongoose.disconnect().finally(() => process.exit(0)); });
      return;
    }
    console.error('HTTP server failed to start', error);
    process.exitCode = 1;
    io.close(() => { void mongoose.disconnect(); });
  });

  void connectDatabase()
    .then(() => httpServer.listen(env.PORT, () => console.info(`BorrowHub API listening on port ${env.PORT}`)))
    .catch((error) => { console.error('Server startup failed', error); process.exitCode = 1; });
}

export default app;
