import 'dart:convert';

/// Mirrors the API error envelope: `{ "error": { code, message, details?, requestId } }`.
/// Only codes and human messages are shown to users; raw bodies are never displayed.
class ApiException implements Exception {
  const ApiException({
    required this.statusCode,
    required this.code,
    required this.message,
    this.details = const [],
    this.requestId,
  });

  /// No response at all (offline, DNS failure, timeout). Status 0 by convention.
  factory ApiException.network() => const ApiException(
        statusCode: 0,
        code: 'NETWORK',
        message: 'No internet connection. Check your network and try again.',
      );

  factory ApiException.sessionEnded() => const ApiException(
        statusCode: 401,
        code: 'UNAUTHENTICATED',
        message: 'Your session has ended. Please sign in again.',
      );

  factory ApiException.fromResponse(int statusCode, String body) {
    try {
      final decoded = jsonDecode(body);
      final error = decoded is Map<String, dynamic> ? decoded['error'] : null;
      if (error is Map<String, dynamic>) {
        final details = error['details'];
        return ApiException(
          statusCode: statusCode,
          code: error['code'] as String? ?? 'UNKNOWN',
          message: error['message'] as String? ?? 'Something went wrong. Please try again.',
          details: details is List ? details.whereType<String>().toList() : const [],
          requestId: error['requestId'] as String?,
        );
      }
    } catch (_) {
      // Non-JSON body (proxy page, HTML error): fall through to the generic message.
    }
    return ApiException(
      statusCode: statusCode,
      code: 'UNKNOWN',
      message: 'Something went wrong. Please try again.',
    );
  }

  final int statusCode;
  final String code;
  final String message;
  final List<String> details;
  final String? requestId;

  /// True when the refresh token can never work again, so local sign-in state must be dropped.
  bool get isSessionDead =>
      statusCode == 401 || code == 'ACCOUNT_SUSPENDED' || code == 'EMAIL_NOT_VERIFIED';

  bool get isNetwork => code == 'NETWORK';

  @override
  String toString() => 'ApiException($code, $statusCode)'; // never include message/details: may echo input
}
