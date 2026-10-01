import 'package:dio/dio.dart';
import 'package:draughts_arena/config/backend_contract.dart';
import 'package:draughts_arena/providers/match_provider.dart';
import 'package:draughts_arena/services/secure_storage.dart';
import 'package:draughts_arena/services/socket_service.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class MockDio extends Mock implements Dio {}

/// Records the joins the provider asks for, standing in for the real socket.
class JoinRecordingSocket extends SocketService {
  JoinRecordingSocket()
    : super(contract: const BackendContractConfig(BackendContractMode.v2));

  final List<String> joined = [];
  int cleared = 0;

  @override
  void joinMatch(String matchId) => joined.add(matchId);

  @override
  void clearJoinedMatch() => cleared += 1;
}

/// GET /matches/:id -- the authoritative per-match lifecycle snapshot. This is
/// what restore consults: /matches/active deliberately omits in-play matches.
Response<dynamic> _snapshot(String matchId, String status) =>
    Response<dynamic>(
      requestOptions: RequestOptions(path: '/matches/$matchId'),
      statusCode: 200,
      data: {
        'data': {'matchId': matchId, 'status': status},
      },
    );

DioException _notFound(String matchId) => DioException(
  requestOptions: RequestOptions(path: '/matches/$matchId'),
  response: Response<dynamic>(
    requestOptions: RequestOptions(path: '/matches/$matchId'),
    statusCode: 404,
  ),
  type: DioExceptionType.badResponse,
);

void main() {
  setUpAll(() {
    registerFallbackValue(Response<dynamic>(requestOptions: RequestOptions()));
  });

  setUp(() {
    TestWidgetsFlutterBinding.ensureInitialized();
  });

  test('a stored match the server still lists is rejoined', () async {
    FlutterSecureStorage.setMockInitialValues({'active_match_id': 'match-1'});
    final dio = MockDio();
    when(() => dio.get<dynamic>(any())).thenAnswer(
      (_) async => _snapshot('match-1', 'READY'),
    );
    final socket = JoinRecordingSocket();
    final notifier = MatchNotifier(socket, dio);

    await notifier.restoreActiveMatch();

    expect(socket.joined, ['match-1']);
    expect(socket.cleared, 0);
    notifier.dispose();
  });

  // Regression: the restore probe used GET /matches/active, which only lists
  // OPEN / FUNDED / READY. Every in-play match was therefore "absent", so
  // returning mid-game deleted the stored pointer and removed the player's
  // only way back to the board.
  test('an IN_PLAY match is rejoined, not mistaken for an ended one', () async {
    FlutterSecureStorage.setMockInitialValues({'active_match_id': 'match-1'});
    final dio = MockDio();
    when(() => dio.get<dynamic>(any())).thenAnswer(
      (_) async => _snapshot('match-1', 'IN_PLAY'),
    );
    final socket = JoinRecordingSocket();
    final notifier = MatchNotifier(socket, dio);

    await notifier.restoreActiveMatch();

    expect(socket.joined, ['match-1']);
    expect(socket.cleared, 0);
    expect(await SecureStorageProbe.read(), 'match-1');
    notifier.dispose();
  });

  test('a settled match is dropped rather than re-entered', () async {
    FlutterSecureStorage.setMockInitialValues({'active_match_id': 'match-1'});
    final dio = MockDio();
    when(() => dio.get<dynamic>(any())).thenAnswer(
      (_) async => _snapshot('match-1', 'SETTLED'),
    );
    final socket = JoinRecordingSocket();
    final notifier = MatchNotifier(socket, dio);

    await notifier.restoreActiveMatch();

    expect(socket.joined, isEmpty);
    expect(socket.cleared, 1);
    expect(await SecureStorageProbe.read(), isNull);
    notifier.dispose();
  });

  // Guards the per-match contract: the probe asks for one specific id, so a
  // snapshot describing a different match means the stored pointer is stale and
  // must not be re-entered.
  test('a snapshot for a different match drops the stale pointer', () async {
    FlutterSecureStorage.setMockInitialValues({'active_match_id': 'match-gone'});
    final dio = MockDio();
    when(() => dio.get<dynamic>(any())).thenAnswer(
      (_) async => _snapshot('match-other', 'READY'),
    );
    final socket = JoinRecordingSocket();
    final notifier = MatchNotifier(socket, dio);

    await notifier.restoreActiveMatch();

    // The phantom must not be re-entered, and the stale room intent is dropped
    // so a later reconnect cannot resurrect it.
    expect(socket.joined, isEmpty);
    expect(socket.cleared, 1);
    expect(await SecureStorageProbe.read(), isNull);
    notifier.dispose();
  });

  test('a 404 clears the pointer without joining', () async {
    FlutterSecureStorage.setMockInitialValues({'active_match_id': 'match-gone'});
    final dio = MockDio();
    when(() => dio.get<dynamic>(any())).thenThrow(_notFound('match-gone'));
    final socket = JoinRecordingSocket();
    final notifier = MatchNotifier(socket, dio);

    await notifier.restoreActiveMatch();

    expect(socket.joined, isEmpty);
    expect(await SecureStorageProbe.read(), isNull);
    notifier.dispose();
  });

  test('an unreachable probe still rejoins rather than stranding', () async {
    FlutterSecureStorage.setMockInitialValues({'active_match_id': 'match-1'});
    final dio = MockDio();
    when(() => dio.get<dynamic>(any())).thenThrow(DioException(requestOptions: RequestOptions()));
    final socket = JoinRecordingSocket();
    final notifier = MatchNotifier(socket, dio);

    await notifier.restoreActiveMatch();

    // Best effort: a failed probe must not strand a genuinely live match.
    expect(socket.joined, ['match-1']);
    expect(socket.cleared, 0);
    notifier.dispose();
  });
}

/// Reads the wrapper's private key through the same public surface the app uses.
class SecureStorageProbe {
  static Future<String?> read() async {
    final storage = SecureStorageService();
    return storage.activeMatchId;
  }
}