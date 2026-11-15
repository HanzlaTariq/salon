import 'package:flutter_test/flutter_test.dart';
import 'package:salon_business/queue/queue_models.dart';

Map<String, dynamic> item(String id, {String status = 'CONFIRMED', Map<String, dynamic> extra = const {}}) => {
      'id': id, 'status': status, 'time': '11:30', 'endTime': '12:00', 'durationMinutes': 30, 'totalPrice': '300.00',
      'customer': {'name': 'Sara', 'phone': null}, 'services': [{'name': 'Haircut'}], 'walkIn': false, 'position': 1,
      'delayMinutes': 0, 'overrunMinutes': 0, 'canStart': true, 'noShow': {'allowed': false, 'allowedFrom': '2026-11-16T06:45:00.000Z', 'graceMinutes': 15},
      ...extra,
    };

void main() {
  test('the booked time and the forecast are both kept and shown', () {
    final i = QueueItem.fromJson(item('a', extra: {
      'estimate': {'time': '11:40', 'delayMinutes': 10},
      'customerEta': {'state': 'RUNNING_LATE', 'etaTime': '11:50'},
    }));
    expect(i.time, '11:30');
    expect(i.estimateTime, '11:40');
    expect(i.isDelayed, isTrue);
    expect(timesText(i), allOf(contains('Booked 11:30'), contains('11:40'), contains('+10 min'), contains('late'), contains('11:50')));
  });

  test('a lane is parsed: current, waiting order, early candidate; staff never get a phone number', () {
    final lane = QueueLane.fromJson({
      'staff': {'id': 's1', 'name': 'Ali', 'isOwner': false},
      'current': item('c', status: 'IN_PROGRESS', extra: {'position': null, 'overrunMinutes': 7}),
      'waiting': [item('w1'), item('w2', extra: {'position': 2, 'walkIn': true, 'earlyOffer': {'offeredTime': '11:25'}})],
      'overdue': [],
      'freeAt': '2026-11-16T06:30:00.000Z', 'freeAtTime': '11:35',
      'earlyOfferCandidate': {'appointmentId': 'w1', 'earliestTime': '11:25', 'savesMinutes': 35},
      'today': {'completed': 3, 'noShows': 1, 'waiting': 2},
      'canAddWalkIn': true,
    });
    expect(lane.staffName, 'Ali');
    expect(lane.current?.inProgress, isTrue);
    expect(lane.waiting.map((w) => w.id), ['w1', 'w2']);
    expect(lane.waiting.first.customerPhone, isNull);
    expect(lane.waiting.last.walkIn, isTrue);
    expect(lane.waiting.last.hasEarlyOffer, isTrue);
    expect(lane.candidate?.savesMinutes, 35);
    expect(lane.completedToday, 3);
    expect(lane.next?.id, 'w1');
    expect(laneStatusText(lane), 'In service, running 7 min over');
  });

  test('Next customer warns first when a service is running: the question names both customers', () {
    final lane = QueueLane.fromJson({
      'staff': {'id': 's1', 'name': 'Ali'},
      'current': item('c', status: 'IN_PROGRESS', extra: {'customer': {'name': 'Bilal'}}),
      'waiting': [item('w1', extra: {'customer': {'name': 'Sara'}})],
    });
    expect(nextConfirmText(lane), 'Complete Bilal and start Sara?');
    final idle = QueueLane.fromJson({'staff': {'id': 's1', 'name': 'Ali'}, 'waiting': [item('w1')], 'freeAtTime': '11:00'});
    expect(nextConfirmText(idle), '');
    expect(laneStatusText(idle), 'Free from 11:00');
    expect(laneStatusText(QueueLane.fromJson({'staff': {'id': 's', 'name': 'x'}})), 'Free now');
  });

  test('missing or broken fields never crash the screen', () {
    final lane = QueueLane.fromJson({'staff': 'broken', 'waiting': 'nope', 'current': 5});
    expect(lane.waiting, isEmpty);
    expect(lane.current, isNull);
    expect(QueueSnapshot.fromJson({}).lanes, isEmpty);
  });

  test('walk-in totals add minutes and money exactly (no floating point)', () {
    const a = OfferedService(id: 'a', name: 'Haircut', durationMinutes: 30, price: '300.00');
    const b = OfferedService(id: 'b', name: 'Beard', durationMinutes: 15, price: '150.50');
    final t = walkInTotals([a, b]);
    expect(t.minutes, 45);
    expect(t.price, '450.50');
    expect(walkInTotals(const []).price, '0.00');
  });
}
