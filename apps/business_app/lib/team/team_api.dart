import 'dart:convert';

import 'package:flutter_core/flutter_core.dart';
import 'package:http/http.dart' as http;

import 'team_models.dart';

/// Client for Phase 5 team endpoints. Owner calls go through [AuthRepository.authorized] (single-flight
/// refresh). The salon id is NEVER sent; the server derives it from the session.
class TeamApi {
  TeamApi({required this.repository, http.Client? client, String? baseUrl})
      : _client = client ?? http.Client(),
        _base = (baseUrl ?? AuthConfig.apiBaseUrl).replaceAll(RegExp(r'/+$'), '');

  final AuthRepository repository;
  final http.Client _client;
  final String _base;

  // ------------------------------------------------------------------ owner
  Future<TeamList> list() async => TeamList.fromJson(await _data('GET', '/salons/mine/team'));

  Future<TeamMember> create({required String displayName, bool self = false, bool performsServices = true, List<String> permissions = const []}) async =>
      TeamMember.fromJson(await _data('POST', '/salons/mine/team', {
        if (self) 'self': true,
        if (!self) 'displayName': displayName,
        'performsServices': performsServices,
        'permissions': permissions,
      }));

  Future<MemberDetail> detail(String id) async => MemberDetail.fromJson(await _data('GET', '/salons/mine/team/$id'));

  Future<TeamMember> update(String id, Map<String, dynamic> body) async =>
      TeamMember.fromJson(await _data('PATCH', '/salons/mine/team/$id', body));

  Future<void> remove(String id) => _send('DELETE', '/salons/mine/team/$id');

  Future<TeamInvitation> invite(String id, String email) async =>
      TeamInvitation.fromJson(await _data('POST', '/salons/mine/team/$id/invitation', {'email': email}));

  Future<void> revokeInvitation(String inviteId) => _send('DELETE', '/salons/mine/team/invitations/$inviteId');

  Future<List<DayHours>> setHours(String id, List<DayHours> days) async {
    final data = await _data('PUT', '/salons/mine/team/$id/working-hours', {'days': days.map((d) => d.toJson()).toList()});
    return (data['workingHours'] as List<dynamic>).map((e) => DayHours.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<List<BreakSlot>> setBreaks(String id, List<BreakSlot> breaks) async {
    final data = await _data('PUT', '/salons/mine/team/$id/breaks', {'breaks': breaks.map((b) => b.toJson()).toList()});
    return (data['breaks'] as List<dynamic>).map((e) => BreakSlot.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<LeaveItem> recordLeave(String id, {required String startsOn, required String endsOn, String? reason}) async =>
      LeaveItem.fromJson(await _data('POST', '/salons/mine/team/$id/leaves', {
        'startsOn': startsOn,
        'endsOn': endsOn,
        if (reason != null && reason.isNotEmpty) 'reason': reason,
      }));

  Future<void> cancelLeave(String staffId, String leaveId) => _send('DELETE', '/salons/mine/team/$staffId/leaves/$leaveId');

  Future<LeaveItem> reviewLeave(String leaveId, {required bool approve}) async =>
      LeaveItem.fromJson(await _data('PATCH', '/salons/mine/team/leaves/$leaveId', {'decision': approve ? 'APPROVE' : 'REJECT'}));

  // ------------------------------------------------------------------ staff (own data only)
  Future<StaffMe> staffMe() async => StaffMe.fromJson(await _data('GET', '/staff/me'));

  Future<List<BreakSlot>> setOwnBreaks(List<BreakSlot> breaks) async {
    final data = await _data('PUT', '/staff/me/breaks', {'breaks': breaks.map((b) => b.toJson()).toList()});
    return (data['breaks'] as List<dynamic>).map((e) => BreakSlot.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<LeaveItem> requestLeave({required String startsOn, required String endsOn, String? reason}) async =>
      LeaveItem.fromJson(await _data('POST', '/staff/me/leaves', {
        'startsOn': startsOn,
        'endsOn': endsOn,
        if (reason != null && reason.isNotEmpty) 'reason': reason,
      }));

  Future<void> withdrawLeaveRequest(String leaveId) => _send('DELETE', '/staff/me/leaves/$leaveId');

  // ------------------------------------------------------------------ public invitation (no session)
  Future<Map<String, dynamic>> previewInvitation(String token) => _public('/public/staff-invitations/preview', {'token': token});

  Future<void> acceptInvitation({required String token, required String fullName, required String password}) async {
    await _public('/public/staff-invitations/accept', {'token': token, 'fullName': fullName, 'password': password});
  }

  // ------------------------------------------------------------------ transport
  Future<Map<String, dynamic>> _data(String method, String path, [Map<String, dynamic>? body]) async {
    final res = await _send(method, path, body);
    final decoded = res.body.isEmpty ? null : jsonDecode(res.body);
    final data = decoded is Map<String, dynamic> ? decoded['data'] : null;
    if (data is! Map<String, dynamic>) throw ApiException.fromResponse(500, '');
    return data;
  }

  Future<http.Response> _send(String method, String path, [Map<String, dynamic>? body]) {
    return repository.authorized((token) async {
      final res = await _raw(method, path, body, headers: {'Authorization': 'Bearer $token'});
      return res;
    });
  }

  Future<Map<String, dynamic>> _public(String path, Map<String, dynamic> body) async {
    final res = await _raw('POST', path, body);
    final decoded = res.body.isEmpty ? null : jsonDecode(res.body);
    final data = decoded is Map<String, dynamic> ? decoded['data'] : null;
    return data is Map<String, dynamic> ? data : <String, dynamic>{};
  }

  Future<http.Response> _raw(String method, String path, Map<String, dynamic>? body, {Map<String, String> headers = const {}}) async {
    http.Response res;
    try {
      final request = http.Request(method, Uri.parse('$_base$path'))
        ..headers.addAll({
          ...headers,
          'Accept': 'application/json',
          'X-Client-Type': 'mobile',
          if (body != null) 'Content-Type': 'application/json',
        });
      if (body != null) request.body = jsonEncode(body);
      res = await http.Response.fromStream(await _client.send(request)).timeout(const Duration(seconds: 20));
    } catch (_) {
      throw ApiException.network();
    }
    if (res.statusCode < 200 || res.statusCode >= 300) throw ApiException.fromResponse(res.statusCode, res.body);
    return res;
  }
}
