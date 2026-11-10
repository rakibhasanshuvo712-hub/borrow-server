import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import app from './app.js';
import { connectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { auth } from './lib/auth.js';
import { fromNodeHeaders } from 'better-auth/node';
import mongoose from 'mongoose';
import { Conversation, Message } from './models/index.js';

export const httpServer = createServer(app);
export const io = new SocketServer(httpServer, { cors: { origin: env.FRONTEND_URL, credentials: true } });
io.use(async (socket, next) => { try { const session = await auth.api.getSession({ headers: fromNodeHeaders(socket.request.headers) }); if (!session) return next(new Error('Unauthorized')); socket.data.userId = session.user.id; next(); } catch { next(new Error('Unauthorized')); } });
io.on('connection', socket => {
  socket.on('conversation:join', async (conversationId: string) => { const conversation = await Conversation.findById(conversationId); if (conversation?.participants.includes(String(socket.data.userId))) socket.join(conversationId); });
  socket.on('message:send', async (payload: { conversationId: string; text: string }) => { const conversation = await Conversation.findById(payload.conversationId); if (!conversation?.participants.includes(String(socket.data.userId)) || !payload.text?.trim()) return; const message = await Message.create({ conversation: conversation._id, sender: String(socket.data.userId), text: payload.text.trim().slice(0,5000) }); conversation.lastMessage = message.text; for (const participant of conversation.participants) if (participant !== String(socket.data.userId)) conversation.unreadCounts.set(participant,(conversation.unreadCounts.get(participant)??0)+1); await conversation.save(); io.to(String(conversation._id)).emit('message:new', message); });
  socket.on('message:read', async (payload: { conversationId: string; messageId?: string }) => { const conversation = await Conversation.findById(payload.conversationId); if (!conversation?.participants.includes(String(socket.data.userId))) return; const filter = { conversation: conversation._id, sender: { $ne: String(socket.data.userId) }, readAt: { $exists: false }, ...(payload.messageId ? { _id: payload.messageId } : {}) }; await Message.updateMany(filter, { $set: { readAt: new Date() } }); conversation.unreadCounts.set(String(socket.data.userId),0); await conversation.save(); io.to(String(conversation._id)).emit('message:read',{conversationId:payload.conversationId,userId:String(socket.data.userId)}); });
});
if (process.env.VERCEL !== '1') {
  httpServer.on('error', (error: NodeJS.ErrnoException) => {
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
    .catch(error => { console.error('Server startup failed', error); process.exitCode = 1; });
}
export default app;
