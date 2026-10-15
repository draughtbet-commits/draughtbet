import 'package:flutter_test/flutter_test.dart';
import 'package:draughts_arena/screens/checkout_webview_screen.dart';

void main() {
  group('isCheckoutReturnNavigation', () {
    test('matches the app scheme so checkout closes on the deep link', () {
      expect(isCheckoutReturnNavigation('draughts://app/payment/callback'), isTrue);
      expect(isCheckoutReturnNavigation('draughts://anything'), isTrue);
    });

    test('matches the backend return page on any host', () {
      expect(
        isCheckoutReturnNavigation(
          'https://api.draughtbet.com/api/v1/payments/return',
        ),
        isTrue,
      );
      expect(
        isCheckoutReturnNavigation('https://api.draughtbet.com/payments/return?ref=x'),
        isTrue,
      );
    });

    test('does not treat provider checkout pages as a return', () {
      expect(
        isCheckoutReturnNavigation('https://checkout.paystack.com/abc123'),
        isFalse,
      );
      expect(
        isCheckoutReturnNavigation('https://checkout.flutterwave.com/v3/hosted/pay'),
        isFalse,
      );
      expect(
        isCheckoutReturnNavigation('https://api.draughtbet.com/api/v1/wallet/balance'),
        isFalse,
      );
      expect(isCheckoutReturnNavigation('not a url'), isFalse);
    });
  });
}
