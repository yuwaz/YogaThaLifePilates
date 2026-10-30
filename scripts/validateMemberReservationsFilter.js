// Disposable validator (not part of product code): exercises getReservations
// memberId/startDate/limit additive filter directly against a throwaway
// temp SQLite DB, bypassing HTTP/auth so it only proves controller logic.
const os = require('os');
const path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), `validate-member-reservations-${Date.now()}.sqlite`);

const assert = require('assert');
const { sequelize, Studio, Member, MemberType, Salon, Equipment, Reservation } = require('../models');
const reservationController = require('../controllers/reservationController');

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    sendStatus(code) { this.statusCode = code; this.body = undefined; return this; },
  };
  return res;
}

async function withFixedNow(isoInstant, callback) {
  const RealDate = Date;
  const fixedTime = new RealDate(isoInstant).getTime();
  global.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fixedTime);
      } else {
        super(...args);
      }
    }
    static now() { return fixedTime; }
  };
  try {
    return await callback();
  } finally {
    global.Date = RealDate;
  }
}

async function callGetReservations(query, user) {
  const req = { query, user };
  const res = mockRes();
  await reservationController.getReservations(req, res);
  return res;
}

(async () => {
  await sequelize.sync({ force: true });

  const studioA = await Studio.create({ name: 'Studio A', studioCode: 'STA001', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });
  const studioB = await Studio.create({ name: 'Studio B', studioCode: 'STB001', country: 'TR', currency: 'TRY', timezone: 'Europe/Istanbul' });

  const memberTypeA = await MemberType.create({ name: 'Basic', color: '#123456', studioId: studioA.id });
  const memberTypeB = await MemberType.create({ name: 'Basic', color: '#123456', studioId: studioB.id });

  const salonA = await Salon.create({ name: 'Salon A', type: 'General', studioId: studioA.id });
  const salonB = await Salon.create({ name: 'Salon B', type: 'General', studioId: studioB.id });

  const equipmentA = await Equipment.create({ name: 'Mat 1', type: 'Mat', salonId: salonA.id, studioId: studioA.id });
  const equipmentB = await Equipment.create({ name: 'Mat 1', type: 'Mat', salonId: salonB.id, studioId: studioB.id });

  const memberA = await Member.create({
    name: 'Alice', phone: '+901234567890', memberTypeId: memberTypeA.id,
    assignedSalonIds: [salonA.id], studioId: studioA.id,
  });
  const otherMemberA = await Member.create({
    name: 'Other', phone: '+901234567891', memberTypeId: memberTypeA.id,
    assignedSalonIds: [salonA.id], studioId: studioA.id,
  });
  const memberB = await Member.create({
    name: 'Bob', phone: '+901234567892', memberTypeId: memberTypeB.id,
    assignedSalonIds: [salonB.id], studioId: studioB.id,
  });
  const limitMemberA = await Member.create({
    name: 'Limit Alice', phone: '+901234567893', memberTypeId: memberTypeA.id,
    assignedSalonIds: [salonA.id], studioId: studioA.id,
  });

  // Alice's reservations: historical, same-day past/future, tomorrow, and far future.
  await Reservation.create({ memberId: memberA.id, equipmentId: equipmentA.id, salonId: salonA.id, date: '2020-01-01', time: '09:00:00', studioId: studioA.id });
  await Reservation.create({ memberId: memberA.id, equipmentId: equipmentA.id, salonId: salonA.id, date: '2026-08-24', time: '09:00:00', studioId: studioA.id });
  await Reservation.create({ memberId: memberA.id, equipmentId: equipmentA.id, salonId: salonA.id, date: '2026-08-24', time: '12:00:00', studioId: studioA.id });
  await Reservation.create({ memberId: memberA.id, equipmentId: equipmentA.id, salonId: salonA.id, date: '2026-08-24', time: '18:00:00', studioId: studioA.id });
  await Reservation.create({ memberId: memberA.id, equipmentId: equipmentA.id, salonId: salonA.id, date: '2026-08-25', time: '10:00:00', studioId: studioA.id });
  await Reservation.create({ memberId: memberA.id, equipmentId: equipmentA.id, salonId: salonA.id, date: '2026-12-01', time: '10:00:00', studioId: studioA.id });
  await Reservation.create({ memberId: otherMemberA.id, equipmentId: equipmentA.id, salonId: salonA.id, date: '2026-09-01', time: '06:00:00', studioId: studioA.id });
  await Reservation.create({ memberId: memberB.id, equipmentId: equipmentB.id, salonId: salonB.id, date: '2026-09-01', time: '06:00:00', studioId: studioB.id });

  const earlyTodayTimes = [
    '06:00:00', '06:15:00', '06:30:00', '06:45:00', '07:00:00',
    '07:15:00', '07:30:00', '07:45:00', '08:00:00', '08:15:00',
    '08:30:00', '08:45:00', '09:00:00', '09:15:00', '09:30:00',
  ];
  for (const time of earlyTodayTimes) {
    await Reservation.create({ memberId: limitMemberA.id, equipmentId: equipmentA.id, salonId: salonA.id, date: '2026-08-24', time, studioId: studioA.id });
  }
  const trueUpcomingForLimit = [
    ['2026-08-24', '18:00:00'],
    ['2026-08-24', '18:15:00'],
    ['2026-08-24', '18:30:00'],
    ['2026-08-24', '18:45:00'],
    ['2026-08-25', '09:00:00'],
    ['2026-08-25', '10:00:00'],
    ['2026-08-25', '11:00:00'],
    ['2026-08-25', '12:00:00'],
    ['2026-08-25', '13:00:00'],
    ['2026-08-25', '14:00:00'],
    ['2026-08-25', '15:00:00'],
  ];
  for (const [date, time] of trueUpcomingForLimit) {
    await Reservation.create({ memberId: limitMemberA.id, equipmentId: equipmentA.id, salonId: salonA.id, date, time, studioId: studioA.id });
  }

  const adminA = { role: 'admin', studioId: studioA.id, assignedSalonIds: [] };
  const adminB = { role: 'admin', studioId: studioB.id, assignedSalonIds: [] };

  // A. No new params -> existing (unfiltered, unordered) behavior, all studio A reservations returned.
  {
    const res = await callGetReservations({}, adminA);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.length, 33, 'expected all 33 studio A reservations with no params');
    console.log('A OK: no-param behavior returns full studio dataset (', res.body.length, 'rows )');
  }

  // B. memberId filters to only that member's reservations.
  {
    const res = await callGetReservations({ memberId: String(memberA.id) }, adminA);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.length, 6);
    assert.ok(res.body.every(r => r.memberId === memberA.id));
    console.log('B OK: memberId returns only that member\'s reservations (', res.body.length, 'rows )');
  }

  // C. memberId + startDate=today applies time-of-day semantics before returning rows.
  {
    const res = await withFixedNow('2026-08-24T14:00:00.000Z', () =>
      callGetReservations({ memberId: String(memberA.id), startDate: '2026-08-24' }, adminA)
    );
    assert.strictEqual(res.statusCode, 200);
    const dates = res.body.map(r => `${r.date} ${r.time}`);
    assert.deepStrictEqual(dates, ['2026-08-24 18:00:00', '2026-08-25 10:00:00', '2026-12-01 10:00:00']);
    console.log('C OK: same-day past reservations excluded before response', dates);
  }

  // D. Far-future reservation (months later) still returned + chronological order.
  {
    const res = await withFixedNow('2026-08-24T14:00:00.000Z', () =>
      callGetReservations({ memberId: String(memberA.id), startDate: '2026-08-24' }, adminA)
    );
    const dates = res.body.map(r => `${r.date} ${r.time}`);
    assert.ok(dates.includes('2026-12-01 10:00:00'));
    console.log('D OK: far-future reservation preserved and chronologically ordered', dates);
  }

  // E. Cross-Studio memberId must not leak Studio A data to Studio B caller.
  {
    const res = await callGetReservations({ memberId: String(memberA.id) }, adminB);
    assert.strictEqual(res.statusCode, 404);
    console.log('E OK: cross-studio memberId rejected with 404, no leakage');
  }

  // F. Invalid memberId -> 400.
  {
    const res = await callGetReservations({ memberId: 'abc' }, adminA);
    assert.strictEqual(res.statusCode, 400);
    console.log('F OK: invalid memberId rejected with 400');
  }

  // G. Earlier-today rows do not consume LIMIT; first 10 true upcoming rows are returned.
  {
    const res = await withFixedNow('2026-08-24T14:00:00.000Z', () =>
      callGetReservations({ memberId: String(limitMemberA.id), startDate: '2026-08-24', limit: '10' }, adminA)
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.length, 10);
    const dates = res.body.map(r => `${r.date} ${r.time}`);
    assert.deepStrictEqual(dates, trueUpcomingForLimit.slice(0, 10).map(([date, time]) => `${date} ${time}`));
    assert.ok(!dates.some(value => value.startsWith('2026-08-24 0')));
    console.log('G OK: earlier-today rows do not consume limit', dates);
  }

  // H. Generic startDate without memberId keeps date-only semantics, including earlier-today rows.
  {
    const res = await withFixedNow('2026-08-24T14:00:00.000Z', () =>
      callGetReservations({ startDate: '2026-08-24' }, adminA)
    );
    assert.strictEqual(res.statusCode, 200);
    const dates = res.body.map(r => `${r.memberId} ${r.date} ${r.time}`);
    assert.ok(dates.includes(`${memberA.id} 2026-08-24 09:00:00`));
    assert.ok(dates.includes(`${memberA.id} 2026-08-24 12:00:00`));
    console.log('H OK: generic startDate remains date-only');
  }

  // I. memberId with a future startDate does not apply today's time filter.
  {
    const res = await withFixedNow('2026-08-24T14:00:00.000Z', () =>
      callGetReservations({ memberId: String(memberA.id), startDate: '2026-08-25', limit: '10' }, adminA)
    );
    assert.strictEqual(res.statusCode, 200);
    const dates = res.body.map(r => `${r.date} ${r.time}`);
    assert.deepStrictEqual(dates, ['2026-08-25 10:00:00', '2026-12-01 10:00:00']);
    console.log('I OK: future startDate keeps date-only lower bound', dates);
  }

  console.log('\nALL VALIDATIONS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('VALIDATION FAILED', err);
  process.exit(1);
});
