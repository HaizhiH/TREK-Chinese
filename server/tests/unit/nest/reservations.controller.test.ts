import { describe, it, expect, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { ReservationsController } from '../../../src/nest/reservations/reservations.controller';
import type { ReservationsService } from '../../../src/nest/reservations/reservations.service';
import type { User } from '../../../src/types';

import { ChinaRailService } from '../../../src/nest/china-rail/china-rail.service';
const rail = new ChinaRailService();

const user = { id: 1, role: 'user', email: 'u@example.test' } as User;
const trip = { id: 5, user_id: 1 };

function makeService(overrides: Partial<ReservationsService> = {}): ReservationsService {
  return {
    verifyTripAccess: vi.fn().mockReturnValue(trip),
    canEdit: vi.fn().mockReturnValue(true),
    broadcast: vi.fn(),
    syncBudgetOnCreate: vi.fn(),
    syncBudgetOnUpdate: vi.fn(),
    notifyBookingChange: vi.fn(),
    ...overrides,
  } as unknown as ReservationsService;
}

function thrown(fn: () => unknown): { status: number; body: unknown } {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    return { status: e.getStatus(), body: e.getResponse() };
  }
  throw new Error('expected throw');
}

describe('ReservationsController (parity with the legacy /api/trips/:tripId/reservations route)', () => {
  it('404 when trip not accessible', () => {
    const svc = makeService({ verifyTripAccess: vi.fn().mockReturnValue(undefined) });
    expect(thrown(() => new ReservationsController(svc, rail).list(user, '5'))).toEqual({ status: 404, body: { error: 'Trip not found' } });
  });

  it('GET / returns reservations', () => {
    const svc = makeService({ list: vi.fn().mockReturnValue([{ id: 1 }]) } as Partial<ReservationsService>);
    expect(new ReservationsController(svc, rail).list(user, '5')).toEqual({ reservations: [{ id: 1 }] });
  });

  describe('POST /', () => {
    it('403 without permission', () => {
      const svc = makeService({ canEdit: vi.fn().mockReturnValue(false) });
      expect(thrown(() => new ReservationsController(svc, rail).create(user, '5', { title: 'Hotel' }))).toEqual({ status: 403, body: { error: 'No permission' } });
    });

    it('400 without a title', () => {
      expect(thrown(() => new ReservationsController(makeService(), rail).create(user, '5', {}))).toEqual({ status: 400, body: { error: 'Title is required' } });
    });

    it('creates, runs budget sync, broadcasts accommodation + reservation, notifies', () => {
      const create = vi.fn().mockReturnValue({ reservation: { id: 9 }, accommodationCreated: true });
      const broadcast = vi.fn(); const syncBudgetOnCreate = vi.fn(); const notifyBookingChange = vi.fn();
      const svc = makeService({ create, broadcast, syncBudgetOnCreate, notifyBookingChange } as Partial<ReservationsService>);
      const body = { title: 'Hotel', type: 'lodging', create_budget_entry: { total_price: 200 } };
      expect(new ReservationsController(svc, rail).create(user, '5', body, 'sock')).toEqual({ reservation: { id: 9 } });
      expect(broadcast).toHaveBeenCalledWith('5', 'accommodation:created', {}, 'sock');
      expect(syncBudgetOnCreate).toHaveBeenCalledWith('5', 9, 'Hotel', 'lodging', { total_price: 200 }, 'sock');
      expect(broadcast).toHaveBeenCalledWith('5', 'reservation:created', { reservation: { id: 9 } }, 'sock');
      expect(notifyBookingChange).toHaveBeenCalledWith('5', user, 'Hotel', 'lodging');
    });
  });

  describe('PUT /positions', () => {
    it('400 when positions is not an array', () => {
      expect(thrown(() => new ReservationsController(makeService(), rail).updatePositions(user, '5', { positions: 'no' }))).toEqual({ status: 400, body: { error: 'positions must be an array' } });
    });

    it('updates positions and broadcasts', () => {
      const updatePositions = vi.fn(); const broadcast = vi.fn();
      const svc = makeService({ updatePositions, broadcast } as Partial<ReservationsService>);
      const positions = [{ id: 1, day_plan_position: 0 }];
      expect(new ReservationsController(svc, rail).updatePositions(user, '5', { positions, day_id: 3 }, 'sock')).toEqual({ success: true });
      expect(updatePositions).toHaveBeenCalledWith('5', positions, 3);
      expect(broadcast).toHaveBeenCalledWith('5', 'reservation:positions', { positions, day_id: 3 }, 'sock');
    });
  });

  describe('PUT /:id', () => {
    it('404 when the reservation is missing', () => {
      const svc = makeService({ getReservation: vi.fn().mockReturnValue(undefined) } as Partial<ReservationsService>);
      expect(thrown(() => new ReservationsController(svc, rail).update(user, '5', '9', { title: 'X' }))).toEqual({ status: 404, body: { error: 'Reservation not found' } });
    });

    it('updates, syncs budget with current fallbacks, broadcasts + notifies', () => {
      const getReservation = vi.fn().mockReturnValue({ title: 'Old', type: 'lodging' });
      const update = vi.fn().mockReturnValue({ reservation: { id: 9 }, accommodationChanged: true });
      const broadcast = vi.fn(); const syncBudgetOnUpdate = vi.fn(); const notifyBookingChange = vi.fn();
      const svc = makeService({ getReservation, update, broadcast, syncBudgetOnUpdate, notifyBookingChange } as Partial<ReservationsService>);
      new ReservationsController(svc, rail).update(user, '5', '9', { create_budget_entry: { total_price: 50 } }, 'sock');
      expect(broadcast).toHaveBeenCalledWith('5', 'accommodation:updated', {}, 'sock');
      expect(syncBudgetOnUpdate).toHaveBeenCalledWith('5', '9', '', undefined, 'Old', 'lodging', { total_price: 50 }, 'sock');
      expect(notifyBookingChange).toHaveBeenCalledWith('5', user, 'Old', 'lodging');
    });
  });

  describe('DELETE /:id', () => {
    it('404 when nothing deleted', () => {
      const svc = makeService({ remove: vi.fn().mockReturnValue({ deleted: undefined, accommodationDeleted: false, deletedBudgetItemId: null }) } as Partial<ReservationsService>);
      expect(thrown(() => new ReservationsController(svc, rail).remove(user, '5', '9'))).toEqual({ status: 404, body: { error: 'Reservation not found' } });
    });

    it('broadcasts the accommodation + budget cascade then reservation:deleted', () => {
      const remove = vi.fn().mockReturnValue({ deleted: { id: 9, title: 'Hotel', type: 'lodging', accommodation_id: 3 }, accommodationDeleted: true, deletedBudgetItemId: 7 });
      const broadcast = vi.fn(); const notifyBookingChange = vi.fn();
      const svc = makeService({ remove, broadcast, notifyBookingChange } as Partial<ReservationsService>);
      expect(new ReservationsController(svc, rail).remove(user, '5', '9', 'sock')).toEqual({ success: true });
      expect(broadcast).toHaveBeenCalledWith('5', 'accommodation:deleted', { accommodationId: 3 }, 'sock');
      expect(broadcast).toHaveBeenCalledWith('5', 'budget:deleted', { itemId: 7 }, 'sock');
      expect(broadcast).toHaveBeenCalledWith('5', 'reservation:deleted', { reservationId: 9 }, 'sock');
    });
  });
});

describe('ReservationsController 12306 endpoint', () => {
  it('checks trip access before sending an upstream request', async () => {
    const queryChinaRailTrain = vi.fn();
    const controller = new ReservationsController(
      makeService({ verifyTripAccess: vi.fn().mockReturnValue(undefined) }),
      { queryChinaRailTrain } as unknown as ChinaRailService,
    );
    await expect(controller.chinaRailTimetable(user, '5', 'G1', '2026-08-26')).rejects.toMatchObject({ status: 404 });
    expect(queryChinaRailTrain).not.toHaveBeenCalled();
  });

  it('delegates to the injected train service and preserves its errors', async () => {
    const result = { trainNumber: 'G1', stops: [] };
    const queryChinaRailTrain = vi.fn().mockResolvedValue(result);
    const controller = new ReservationsController(makeService(), { queryChinaRailTrain } as unknown as ChinaRailService);
    await expect(controller.chinaRailTimetable(user, '5', 'G1', '2026-08-26')).resolves.toEqual(result);
    expect(queryChinaRailTrain).toHaveBeenCalledWith('G1', '2026-08-26');
    queryChinaRailTrain.mockRejectedValue(Object.assign(new Error('Train not found'), { status: 404 }));
    await expect(controller.chinaRailTimetable(user, '5', 'G1', '2026-08-26')).rejects.toMatchObject({ status: 404 });
    await expect(controller.chinaRailTimetable(user, '5')).rejects.toMatchObject({ status: 400 });
  });
});
