import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../services/api_client.dart';

class UserProfile {
  const UserProfile({
    required this.id,
    this.email,
    this.username,
    this.fullName,
    this.avatar,
    this.tier = 'AMATEUR',
    this.walletBalanceMinorUnits = 0,
    this.unreadNotifications = 0,
  });

  final String id;
  final String? email;
  final String? username;
  final String? fullName;
  final String? avatar;
  final String tier;
  final int walletBalanceMinorUnits;
  final int unreadNotifications;

  String get displayName =>
      (username != null && username!.isNotEmpty)
          ? username!
          : (fullName != null && fullName!.isNotEmpty)
              ? fullName!
              : (email?.split('@').first ?? 'Player');

  factory UserProfile.fromJson(Map<String, dynamic> json) {
    return UserProfile(
      id: json['id'] as String? ?? '',
      email: json['email'] as String?,
      username: json['username'] as String?,
      fullName: json['fullName'] as String?,
      avatar: json['avatar'] as String?,
      tier: json['tier'] as String? ?? 'AMATEUR',
      walletBalanceMinorUnits:
          int.tryParse(json['walletBalanceMinorUnits']?.toString() ?? '') ?? 0,
      unreadNotifications:
          int.tryParse(json['unreadNotifications']?.toString() ?? '') ?? 0,
    );
  }

  UserProfile copyWith({String? avatar}) {
    return UserProfile(
      id: id,
      email: email,
      username: username,
      fullName: fullName,
      avatar: avatar ?? this.avatar,
      tier: tier,
      walletBalanceMinorUnits: walletBalanceMinorUnits,
      unreadNotifications: unreadNotifications,
    );
  }
}

class ProfileState {
  const ProfileState({this.isLoading = false, this.error, this.profile});

  final bool isLoading;
  final String? error;
  final UserProfile? profile;
}

class ProfileNotifier extends StateNotifier<ProfileState> {
  ProfileNotifier(this._dio) : super(const ProfileState());

  final Dio _dio;

  Future<void> load() async {
    if (state.profile != null) return;
    state = const ProfileState(isLoading: true);
    try {
      final res = await _dio.get('/auth/me');
      if (res.statusCode == 200) {
        state = ProfileState(
          profile: UserProfile.fromJson(res.data as Map<String, dynamic>),
        );
      }
    } on DioException {
      state = const ProfileState(error: 'Failed to load profile');
    }
  }

  /// Persists a predesigned avatar id and refreshes the local profile.
  Future<bool> setAvatar(String avatarId) async {
    try {
      final res = await _dio.patch('/auth/me', data: {'avatar': avatarId});
      if (res.statusCode == 200) {
        final data = res.data as Map<String, dynamic>;
        final current = state.profile;
        state = ProfileState(
          profile: current?.copyWith(avatar: data['avatar'] as String?),
        );
        return true;
      }
      return false;
    } on DioException {
      return false;
    }
  }

  void refreshAfterSession() {
    state = const ProfileState();
  }
}

final profileProvider = StateNotifierProvider<ProfileNotifier, ProfileState>(
  (ref) => ProfileNotifier(ref.read(apiClientProvider)),
);