/// Predesigned avatars only — we deliberately have no uploads for security
/// reasons. The backend stores the avatar id (e.g. `avatar_03`); the app
/// maps it to a bundled SVG asset.
class PlayerAvatar {
  const PlayerAvatar(this.id, this.assetPath);

  final String id;
  final String assetPath;
}

const List<PlayerAvatar> avatarCatalog = [
  PlayerAvatar('avatar_01', 'assets/avatars/avatar_01.svg'),
  PlayerAvatar('avatar_02', 'assets/avatars/avatar_02.svg'),
  PlayerAvatar('avatar_03', 'assets/avatars/avatar_03.svg'),
  PlayerAvatar('avatar_04', 'assets/avatars/avatar_04.svg'),
  PlayerAvatar('avatar_05', 'assets/avatars/avatar_05.svg'),
  PlayerAvatar('avatar_06', 'assets/avatars/avatar_06.svg'),
  PlayerAvatar('avatar_07', 'assets/avatars/avatar_07.svg'),
  PlayerAvatar('avatar_08', 'assets/avatars/avatar_08.svg'),
  PlayerAvatar('avatar_09', 'assets/avatars/avatar_09.svg'),
  PlayerAvatar('avatar_10', 'assets/avatars/avatar_10.svg'),
  PlayerAvatar('avatar_11', 'assets/avatars/avatar_11.svg'),
  PlayerAvatar('avatar_12', 'assets/avatars/avatar_12.svg'),
];

PlayerAvatar? avatarById(String? id) {
  if (id == null) return null;
  for (final a in avatarCatalog) {
    if (a.id == id) return a;
  }
  return null;
}

/// Fallback shown until a user picks an avatar.
const PlayerAvatar defaultAvatar = PlayerAvatar('avatar_01', 'assets/avatars/avatar_01.svg');