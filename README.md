# BorrowHub API

Express 5 + TypeScript backend for the BorrowHub peer-to-peer rental marketplace. It uses Better Auth sessions, MongoDB/Mongoose, Cloudinary, and Socket.io. The frontend origin and all credentials are configured with environment variables.

## Setup

1. Install Node.js 20+, MongoDB Atlas (with a database user and network access configured), and a Cloudinary account.
2. Fill the root `.env` file, or copy `.env.example` to `.env`. The `.env` file is ignored by Git. Use a long random `BETTER_AUTH_SECRET`. Set `FRONTEND_URL` to the deployed frontend origin and `BETTER_AUTH_URL` to the deployed API URL. In production configure `COOKIE_SAME_SITE=none` when frontend and API are on different sites; HTTPS is required for secure cookies.
3. Run `npm install`, `npm run dev`, `npm run seed`, and `npm run build`.
4. Seed demo accounts are listed in `src/seed.ts`; change their passwords before using any non-disposable environment.

## Vercel deployment

Import this repository into Vercel and set all `.env.example` variables in Project Settings for Production and Preview. `vercel.json` routes requests to the root `index.js` Express function. Deploy with `vercel --prod`. A serverless function cannot keep a persistent Socket.io connection; deploy the same API on a persistent Node host for live sockets or use a managed Socket.io-compatible realtime service. REST conversation/message endpoints remain available as fallback. Ensure the Atlas network policy allows Vercel egress or use Atlas network access configuration suitable for serverless deployments.

## API

All application endpoints use `/api`. Responses follow `{ success, data, message, meta? }`; errors use `{ success:false, message, errors? }`. Auth endpoints are managed by Better Auth at `/api/auth/*`.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Health check |
| GET, PATCH | `/me` | Current profile |
| GET | `/categories` | Categories |
| GET, POST | `/items` | Search or create listing |
| GET | `/items/featured` | Homepage featured items |
| GET, PATCH, DELETE | `/items/:id` | Listing detail and owner management |
| GET | `/items/:id/availability` | Booked dates |
| POST | `/uploads/images` | Upload up to 8 images |
| GET | `/owners/:id` | Public owner page |
| POST | `/bookings/quote`, `/bookings` | Quote or create booking |
| GET | `/bookings/mine`, `/bookings/:id` | Booking lists and detail |
| PATCH | `/bookings/:id/status` | Enforced booking transitions |
| POST | `/bookings/:id/photos`, `/reviews` | Condition photos or review |
| GET | `/items/:id/reviews` | Item reviews |
| GET, POST, DELETE | `/favorites` | Favorites |
| GET, POST | `/conversations`, `/conversations/:id/messages` | REST chat and history |
| GET | `/dashboard/renter`, `/dashboard/owner` | User dashboards |
| GET, PATCH | `/admin/*` | Admin users, listings, bookings, disputes, verifications |
| PATCH | `/admin/items/:id/feature` | Toggle homepage featured status |
| POST | `/disputes` | Open booking dispute |

See `requests.http` for common calls. Socket.io authenticates with the Better Auth session cookie and supports `conversation:join`, `message:send`, `message:new`, `message:read`.
