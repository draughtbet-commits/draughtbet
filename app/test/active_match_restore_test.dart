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

Response<dynamic> _activeList(List<Map<String, dynamic>> items) =>
    Response<dynamic>(
      requestOptions: RequestOptions(path: '/matches/active'),
      statusCode: 200,
      data: {'data': items},
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
      (_) async => _activeList([
        {'matchId': 'match-1'},
      ]),
    );
    final socket = JoinRecordingSocket();
    final notifier = MatchNotifier(socket, dio);

    await notifier.restoreActiveMatch();

    expect(socket.joined, ['match-1']);
    expect(socket.cleared, 0);
    notifier.dispose();
  });

  test('a stored match the server no longer lists is dropped', () async {
    FlutterSecureStorage.setMockInitialValues({'active_match_id': 'match-gone'});
    final dio = MockDio();
    when(() => dio.get<dynamic>(any())).thenAnswer(
      (_) async => _activeList([
        {'matchId': 'match-other'},
      ]),
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

  test('an empty active list clears the pointer without joining', () async {
    FlutterSecureStorage.setMockInitialValues({'active_match_id': 'match-gone'});
    final dio = MockDio();
    when(() => dio.get<dynamic>(any())).thenAnswer(
      (_) async => _activeList(const []),
    );
    final socket = JoinRecordingSocket();
    final notifier = MatchNotifier(socket, dio);

    await notifier.restoreActiveMatch();

    expect(socket.joined, isEmpty);
    expect(await SecureStorageProbe.read(), isNull);
    notifier.dispose();
  });

  test('an unreachable active list still rejoins rather than stranding', () async {
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