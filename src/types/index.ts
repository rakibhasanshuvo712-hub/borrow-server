export type ApiEnvelope<T> = { success: true; data: T; message: string; meta?: Record<string, unknown> };
export type ApiError = { success: false; message: string; errors?: unknown };
export type AccountType = 'renter' | 'owner' | 'both';
export type UserRole = 'renter' | 'owner' | 'admin';
export type ItemCondition = 'New' | 'Like New' | 'Excellent' | 'Good' | 'Fair';
export type ItemStatus = 'pending' | 'approved' | 'rejected' | 'paused';
export type BookingStatus = 'requested' | 'approved' | 'paid' | 'picked_up' | 'active' | 'returned' | 'completed' | 'rejected' | 'cancelled' | 'disputed';
export type BookingAction = 'approve' | 'reject' | 'pay' | 'pickup' | 'return' | 'complete' | 'cancel';
export interface PriceBreakdown { rate: number; rentalTotal: number; serviceFee: number; deposit: number; grandTotal: number }
export interface PaginationMeta { page: number; limit: number; total: number; pages?: number }
export interface ItemSummary { id: string; name: string; category: string; condition: ItemCondition; images: string[]; pricing: { daily: number; weekly: number; monthly: number }; avgRating: number; reviewCount: number; status: ItemStatus }
export interface BookingSummary { id: string; item: string; renter: string; owner: string; startDate: string; endDate: string; days: number; pricing: PriceBreakdown; status: BookingStatus }
