import mongoose from 'mongoose';
import { env } from './env.js';

let connection: Promise<void> | undefined;
export async function connectDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 1) return;
  if (connection) return connection;
  connection = connectWithRetry();
  try { await connection; } catch (error) { connection = undefined; throw error; }
}
async function connectWithRetry(): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try { await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 }); console.info('MongoDB connected'); return; }
    catch (error) { console.error(`MongoDB connection attempt ${attempt}/5 failed`, error); if (attempt === 5) throw error; await new Promise(resolve => setTimeout(resolve, attempt * 1500)); }
  }
}
