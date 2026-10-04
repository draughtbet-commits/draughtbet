import 'package:draughts_arena/models/support_case.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SupportCaseStatus wire contract', () {
    test('maps every status the backend can emit', () {
      expect(
        SupportCaseStatus.fromWire('OPEN'),
        SupportCaseStatus.open,
      );
      expect(
        SupportCaseStatus.fromWire('IN_PROGRESS'),
        SupportCaseStatus.inProgress,
      );
      expect(
        SupportCaseStatus.fromWire('WAITING_USER'),
        SupportCaseStatus.waitingOnPlayer,
      );
      expect(
        SupportCaseStatus.fromWire('RESOLVED'),
        SupportCaseStatus.resolved,
      );
      expect(
        SupportCaseStatus.fromWire('CLOSED'),
        SupportCaseStatus.closed,
      );
    });

    test('does not silently degrade a live status to unknown', () {
      // Regression guard: the app previously expected IN_REVIEW /
      // WAITING_ON_PLAYER, which the backend never sends.
      for (final wire in ['OPEN', 'IN_PROGRESS', 'WAITING_USER']) {
        expect(
          SupportCaseStatus.fromWire(wire),
          isNot(SupportCaseStatus.unknown),
          reason: '$wire must round-trip to a known status',
        );
        expect(SupportCaseStatus.fromWire(wire).isOpen, isTrue);
      }
    });

    test('resolved and closed are not open', () {
      expect(SupportCaseStatus.fromWire('RESOLVED').isOpen, isFalse);
      expect(SupportCaseStatus.fromWire('CLOSED').isOpen, isFalse);
    });

    test('unknown wire values degrade safely', () {
      expect(SupportCaseStatus.fromWire('SOMETHING_NEW'), SupportCaseStatus.unknown);
      expect(SupportCaseStatus.fromWire(null), SupportCaseStatus.unknown);
    });
  });

  group('SupportCaseType wire contract', () {
    test('maps every type the backend can emit', () {
      for (final wire in [
        'GENERAL',
        'PAYMENT',
        'WITHDRAWAL',
        'KYC',
        'MATCH',
        'ACCOUNT',
        'SAFER_PLAY',
      ]) {
        expect(
          SupportCaseType.fromWire(wire).wireValue,
          wire,
          reason: '$wire must round-trip',
        );
      }
      expect(SupportCaseType.fromWire('account'), SupportCaseType.account);
      expect(SupportCaseType.fromWire('nope'), SupportCaseType.general);
    });
  });

  group('maskedReference', () {
    test('never exposes the full case id', () {
      final c = SupportCase.tryFromServer({
        'id': 'a04fd9b2c-1111-2222-3333-44445555666679b',
        'type': 'ACCOUNT',
        'status': 'OPEN',
        'subject': 'Account restricted — please review',
      })!;
      expect(c.maskedReference, 'a04••••79b');
      expect(c.maskedReference.contains('44445555'), isFalse);
    });

    test('degrades instead of leaking a short id', () {
      final c = SupportCase.tryFromServer({
        'id': 'abc',
        'type': 'ACCOUNT',
        'status': 'OPEN',
        'subject': 'x',
      })!;
      expect(c.maskedReference, 'Unavailable');
    });
  });

  group('tryFromServer', () {
    test('parses a real payload', () {
      final c = SupportCase.tryFromServer({
        'id': 'case-1',
        'type': 'ACCOUNT',
        'status': 'IN_PROGRESS',
        'subject': 'Restricted',
        'description': 'Cannot deposit',
        'createdAt': '2026-10-03T10:00:00.000Z',
      })!;
      expect(c.id, 'case-1');
      expect(c.type, SupportCaseType.account);
      expect(c.status, SupportCaseStatus.inProgress);
      expect(c.description, 'Cannot deposit');
      expect(c.createdAt, isNotNull);
    });

    test('rejects unusable payloads', () {
      expect(SupportCase.tryFromServer(null), isNull);
      expect(SupportCase.tryFromServer('nope'), isNull);
      expect(SupportCase.tryFromServer({'type': 'ACCOUNT'}), isNull);
      expect(SupportCase.tryFromServer({'id': ''}), isNull);
    });

    test('listFromServer skips malformed rows', () {
      final list = SupportCase.listFromServer([
        {'id': 'a', 'type': 'ACCOUNT', 'status': 'OPEN', 'subject': 'one'},
        'garbage',
        null,
        {'id': 'b', 'type': 'KYC', 'status': 'CLOSED', 'subject': 'two'},
      ]);
      expect(list.map((c) => c.id), ['a', 'b']);
      expect(SupportCase.listFromServer('nope'), isEmpty);
    });
  });
}