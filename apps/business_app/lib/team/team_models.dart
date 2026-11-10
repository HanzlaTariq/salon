/// Phase 5 models. Mirror the API views in apps/api/src/modules/staff (team.service.ts / staff-self.service.ts).

const kStaffPermissionLabels = <String, String>{
  'walk_ins.create': 'Add walk-in customers',
  'schedule.manage_own': 'Manage own breaks and request leave',
};

const kWeekdayNames = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

class TeamInvitation {
  const TeamInvitation({required this.id, required this.email, required this.expiresAt});

  final String id;
  final String email;
  final String expiresAt;

  factory TeamInvitation.fromJson(Map<String, dynamic> j) => TeamInvitation(
        id: j['id'] as String,
        email: j['email'] as String,
        expiresAt: j['expiresAt'] as String,
      );
}

class TeamMember {
  const TeamMember({
    required this.id,
    required this.displayName,
    required this.bio,
    required this.isOwner,
    required this.isActive,
    required this.performsServices,
    required this.billable,
    required this.permissions,
    required this.account,
    required this.invitation,
  });

  final String id;
  final String displayName;
  final String? bio;
  final bool isOwner;
  final bool isActive;
  final bool performsServices;
  final bool billable;
  final List<String> permissions;

  /// NO_ACCOUNT | INVITED | INVITE_EXPIRED | LINKED
  final String account;
  final TeamInvitation? invitation;

  bool get linked => account == 'LINKED';

  factory TeamMember.fromJson(Map<String, dynamic> j) {
    final inv = j['invitation'];
    return TeamMember(
      id: j['id'] as String,
      displayName: j['displayName'] as String,
      bio: j['bio'] as String?,
      isOwner: j['isOwner'] as bool,
      isActive: j['isActive'] as bool,
      performsServices: j['performsServices'] as bool,
      billable: j['billable'] as bool,
      permissions: (j['permissions'] as List<dynamic>).cast<String>(),
      account: j['account'] as String,
      invitation: inv is Map<String, dynamic> ? TeamInvitation.fromJson(inv) : null,
    );
  }
}

class TeamBilling {
  const TeamBilling({required this.billableStaff, required this.activeNonPerforming, required this.inactive, required this.ownerBillable});

  final int billableStaff;
  final int activeNonPerforming;
  final int inactive;
  final bool ownerBillable;

  factory TeamBilling.fromJson(Map<String, dynamic> j) => TeamBilling(
        billableStaff: j['billableStaff'] as int,
        activeNonPerforming: j['activeNonPerforming'] as int,
        inactive: j['inactive'] as int,
        ownerBillable: j['ownerBillable'] as bool,
      );
}

class TeamList {
  const TeamList({required this.canEdit, required this.members, required this.billing});

  final bool canEdit;
  final List<TeamMember> members;
  final TeamBilling billing;

  factory TeamList.fromJson(Map<String, dynamic> j) => TeamList(
        canEdit: j['canEdit'] as bool,
        members: (j['members'] as List<dynamic>).map((e) => TeamMember.fromJson(e as Map<String, dynamic>)).toList(),
        billing: TeamBilling.fromJson(j['billing'] as Map<String, dynamic>),
      );
}

/// One weekday. `configured: false` means the owner has not set hours for this day yet.
class DayHours {
  const DayHours({required this.weekday, required this.configured, required this.off, this.startsAt, this.endsAt});

  final int weekday;
  final bool configured;
  final bool off;
  final String? startsAt;
  final String? endsAt;

  DayHours copyWith({bool? off, String? startsAt, String? endsAt}) => DayHours(
        weekday: weekday,
        configured: true,
        off: off ?? this.off,
        startsAt: startsAt ?? this.startsAt,
        endsAt: endsAt ?? this.endsAt,
      );

  factory DayHours.fromJson(Map<String, dynamic> j) => DayHours(
        weekday: j['weekday'] as int,
        configured: j['configured'] as bool,
        off: j['off'] as bool,
        startsAt: j['startsAt'] as String?,
        endsAt: j['endsAt'] as String?,
      );

  Map<String, dynamic> toJson() => {
        'weekday': weekday,
        'off': off,
        if (!off) 'startsAt': startsAt ?? '11:00',
        if (!off) 'endsAt': endsAt ?? '19:00',
      };
}

class BreakSlot {
  const BreakSlot({required this.weekday, required this.startsAt, required this.endsAt, required this.label});

  final int weekday;
  final String startsAt;
  final String endsAt;
  final String label;

  factory BreakSlot.fromJson(Map<String, dynamic> j) => BreakSlot(
        weekday: j['weekday'] as int,
        startsAt: j['startsAt'] as String,
        endsAt: j['endsAt'] as String,
        label: j['label'] as String,
      );

  Map<String, dynamic> toJson() => {'weekday': weekday, 'startsAt': startsAt, 'endsAt': endsAt, 'label': label};
}

class LeaveItem {
  const LeaveItem({required this.id, required this.staffId, required this.startsOn, required this.endsOn, required this.status, required this.reason});

  final String id;
  final String staffId;
  final String startsOn;
  final String endsOn;

  /// PENDING | APPROVED | REJECTED | CANCELLED
  final String status;
  final String? reason;

  factory LeaveItem.fromJson(Map<String, dynamic> j) => LeaveItem(
        id: j['id'] as String,
        staffId: (j['staffId'] as String?) ?? '',
        startsOn: j['startsOn'] as String,
        endsOn: j['endsOn'] as String,
        status: j['status'] as String,
        reason: j['reason'] as String?,
      );
}

class MemberDetail {
  const MemberDetail({required this.member, required this.workingHours, required this.breaks, required this.leaves});

  final TeamMember member;
  final List<DayHours> workingHours;
  final List<BreakSlot> breaks;
  final List<LeaveItem> leaves;

  factory MemberDetail.fromJson(Map<String, dynamic> j) => MemberDetail(
        member: TeamMember.fromJson(j['member'] as Map<String, dynamic>),
        workingHours: (j['workingHours'] as List<dynamic>).map((e) => DayHours.fromJson(e as Map<String, dynamic>)).toList(),
        breaks: (j['breaks'] as List<dynamic>).map((e) => BreakSlot.fromJson(e as Map<String, dynamic>)).toList(),
        leaves: (j['leaves'] as List<dynamic>).map((e) => LeaveItem.fromJson(e as Map<String, dynamic>)).toList(),
      );
}

/// The signed-in staff member's own dashboard (GET /staff/me). Contains nothing about colleagues.
class StaffMe {
  const StaffMe({
    required this.id,
    required this.displayName,
    required this.permissions,
    required this.salonName,
    required this.salonStatus,
    required this.workingHours,
    required this.breaks,
    required this.leaves,
  });

  final String id;
  final String displayName;
  final List<String> permissions;
  final String salonName;
  final String salonStatus;
  final List<DayHours> workingHours;
  final List<BreakSlot> breaks;
  final List<LeaveItem> leaves;

  bool get canManageOwnSchedule => permissions.contains('schedule.manage_own');

  factory StaffMe.fromJson(Map<String, dynamic> j) {
    final p = j['profile'] as Map<String, dynamic>;
    final s = j['salon'] as Map<String, dynamic>;
    return StaffMe(
      id: p['id'] as String,
      displayName: p['displayName'] as String,
      permissions: (p['permissions'] as List<dynamic>).cast<String>(),
      salonName: s['name'] as String,
      salonStatus: s['status'] as String,
      workingHours: (j['workingHours'] as List<dynamic>).map((e) => DayHours.fromJson(e as Map<String, dynamic>)).toList(),
      breaks: (j['breaks'] as List<dynamic>).map((e) => BreakSlot.fromJson(e as Map<String, dynamic>)).toList(),
      leaves: (j['leaves'] as List<dynamic>).map((e) => LeaveItem.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }
}
