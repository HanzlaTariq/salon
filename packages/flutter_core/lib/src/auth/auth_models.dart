/// Public user as returned by the API (`PublicUser` in apps/api). Contains no secrets.
class AuthUser {
  const AuthUser({
    required this.id,
    required this.email,
    required this.fullName,
    required this.role,
    required this.emailVerified,
    required this.mfaEnabled,
    this.phone,
  });

  factory AuthUser.fromJson(Map<String, dynamic> json) => AuthUser(
        id: json['id'] as String,
        email: json['email'] as String,
        fullName: json['fullName'] as String,
        phone: json['phone'] as String?,
        role: json['role'] as String,
        emailVerified: json['emailVerified'] as bool? ?? false,
        mfaEnabled: json['mfaEnabled'] as bool? ?? false,
      );

  final String id;
  final String email;
  final String fullName;
  final String? phone;
  final String role;
  final bool emailVerified;
  final bool mfaEnabled;
}

/// Tokens plus the user. The refresh token is only kept in secure storage, never in plain state.
class AuthSession {
  const AuthSession({
    required this.accessToken,
    required this.expiresAt,
    required this.refreshToken,
    required this.user,
    required this.mfaEnrollmentRequired,
  });

  factory AuthSession.fromJson(Map<String, dynamic> json) {
    final expiresIn = (json['expiresIn'] as num).toInt();
    return AuthSession(
      accessToken: json['accessToken'] as String,
      expiresAt: DateTime.now().toUtc().add(Duration(seconds: expiresIn)),
      refreshToken: json['refreshToken'] as String,
      user: AuthUser.fromJson(json['user'] as Map<String, dynamic>),
      mfaEnrollmentRequired: json['mfaEnrollmentRequired'] as bool? ?? false,
    );
  }

  final String accessToken;
  final DateTime expiresAt;
  final String refreshToken;
  final AuthUser user;
  final bool mfaEnrollmentRequired;

  /// Refresh a minute early so a request does not start with a token about to expire.
  bool get expiresSoon => DateTime.now().toUtc().isAfter(expiresAt.subtract(const Duration(seconds: 60)));
}
