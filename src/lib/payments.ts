export interface PaymentProvider { charge(input: { bookingId: string; amount: number; userId: string }): Promise<{ reference: string; status: 'paid' }> }
export class MockPaymentProvider implements PaymentProvider { async charge(input: { bookingId: string; amount: number; userId: string }): Promise<{ reference: string; status: 'paid' }> { return { reference: `mock_${input.bookingId}_${Date.now()}`, status: 'paid' }; } }
export const paymentProvider: PaymentProvider = new MockPaymentProvider();
