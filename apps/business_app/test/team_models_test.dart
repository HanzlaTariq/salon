import 'package:flutter_test/flutter_test.dart';
import 'package:salon_business/team/team_models.dart';

void main() {
  test('TeamList parses members, billing and invitation state', () {
    final list = TeamList.fromJson({
      'canEdit': true,
      'members': [
        {
          'id': 'a1', 'displayName': 'Ali', 'bio': null, 'isOwner': false, 'isActive': true, 'performsServices': true,
          'billable': true, 'permissions': ['schedule.manage_own'], 'account': 'INVITED',
          'invitation': {'id': 'i1', 'email': 'ali@example.com', 'expiresAt': '2026-11-13T10:00:00.000Z'},
        },
      ],
      'billing': {'billableStaff': 1, 'activeNonPerforming': 0, 'inactive': 0, 'ownerBillable': false},
    });
    expect(list.canEdit, isTrue);
    expect(list.members.single.linked, isFalse);
    expect(list.members.single.invitation?.email, 'ali@example.com');
    expect(list.members.single.permissions, ['schedule.manage_own']);
    expect(list.billing.billableStaff, 1);
  });

  test('DayHours serialises off days without times and on days with times', () {
    const off = DayHours(weekday: 7, configured: true, off: true);
    const on = DayHours(weekday: 1, configured: true, off: false, startsAt: '11:00', endsAt: '19:00');
    expect(off.toJson(), {'weekday': 7, 'off': true});
    expect(on.toJson(), {'weekday': 1, 'off': false, 'startsAt': '11:00', 'endsAt': '19:00'});
  });

  test('StaffMe exposes only own data and the schedule permission flag', () {
    final me = StaffMe.fromJson({
      'profile': {'id': 'p1', 'displayName': 'Ali', 'bio': null, 'performsServices': true, 'isActive': true, 'permissions': <String>[]},
      'salon': {'id': 's1', 'name': 'Glow', 'status': 'APPROVED'},
      'workingHours': <Map<String, dynamic>>[],
      'breaks': <Map<String, dynamic>>[],
      'leaves': <Map<String, dynamic>>[],
    });
    expect(me.canManageOwnSchedule, isFalse);
    expect(me.salonName, 'Glow');
  });

  test('MemberDetail parses breaks and leave', () {
    final d = MemberDetail.fromJson({
      'member': {
        'id': 'a1', 'displayName': 'Ali', 'bio': null, 'isOwner': false, 'isActive': true, 'performsServices': true,
        'billable': true, 'permissions': <String>[], 'account': 'NO_ACCOUNT', 'invitation': null,
      },
      'workingHours': [{'weekday': 1, 'configured': true, 'off': false, 'startsAt': '11:00', 'endsAt': '19:00'}],
      'breaks': [{'weekday': 1, 'startsAt': '13:00', 'endsAt': '13:30', 'label': 'Lunch'}],
      'leaves': [{'id': 'l1', 'staffId': 'a1', 'startsOn': '2026-12-01', 'endsOn': '2026-12-02', 'status': 'PENDING', 'reason': null}],
    });
    expect(d.breaks.single.label, 'Lunch');
    expect(d.leaves.single.status, 'PENDING');
    expect(kWeekdayNames[1], 'Monday');
  });
}
