import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';
import '../widgets/flow_widgets.dart';

enum CheckoutExit { returned }

/// The provider redirects to the backend return page when the player leaves
/// hosted checkout; that page then bounces to the app scheme below. Catching
/// either navigation lets checkout close the moment the player is done, instead
/// of leaving them staring at a provider page.
const String checkoutReturnScheme = 'draughts';
const String checkoutReturnPathSuffix = '/payments/return';

/// True when [url] is the checkout-return navigation (app scheme or the
/// backend return page). This is a signal to leave checkout only — it is never
/// treated as proof of payment.
bool isCheckoutReturnNavigation(String url) {
  final uri = Uri.tryParse(url);
  if (uri == null) return false;
  if (uri.scheme == checkoutReturnScheme) return true;
  return uri.path.endsWith(checkoutReturnPathSuffix);
}

class CheckoutWebviewScreen extends StatefulWidget {
  final Uri authorizationUrl;

  const CheckoutWebviewScreen({super.key, required this.authorizationUrl});

  @override
  State<CheckoutWebviewScreen> createState() => _CheckoutWebviewScreenState();
}

class _CheckoutWebviewScreenState extends State<CheckoutWebviewScreen> {
  late final WebViewController _controller;
  bool _loading = true;
  bool _loadFailed = false;
  bool _returning = false;

  /// Closes checkout exactly once. Returning is only a signal to stop the
  /// checkout flow — it is never treated as proof of payment; the caller
  /// re-reads authoritative status from the API.
  void _completeReturn() {
    if (_returning || !mounted) return;
    _returning = true;
    Navigator.of(context).pop(CheckoutExit.returned);
  }

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(AppColors.voidBg)
      ..setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (NavigationRequest request) {
            // A provider URL is never evidence of payment success, but a
            // navigation back to our return URL (or the app scheme) does mean
            // checkout is over — so leave and let the API decide.
            if (isCheckoutReturnNavigation(request.url)) {
              _completeReturn();
              return NavigationDecision.prevent;
            }
            return NavigationDecision.navigate;
          },
          onPageStarted: (_) {
            if (!mounted) return;
            setState(() {
              _loading = true;
              _loadFailed = false;
            });
          },
          onPageFinished: (_) {
            if (!mounted) return;
            setState(() => _loading = false);
          },
          onWebResourceError: (WebResourceError error) {
            // A failed sub-resource is noise; only a main-document failure
            // means there is no payment page for the player to use. Without
            // this the player was left staring at a blank page.
            if (!(error.isForMainFrame ?? true)) return;
            if (!mounted) return;
            setState(() {
              _loading = false;
              _loadFailed = true;
            });
          },
        ),
      )
      ..loadRequest(widget.authorizationUrl);
  }

  void _retry() {
    setState(() {
      _loading = true;
      _loadFailed = false;
    });
    _controller.loadRequest(widget.authorizationUrl);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.voidBg,
      appBar: AppBar(
        backgroundColor: AppColors.surface1,
        title: Text('Complete Payment', style: AppTypography.heading3),
        leading: IconButton(
          icon: const Icon(Icons.close, color: AppColors.textPrimary),
          onPressed: _completeReturn,
        ),
      ),
      body: _loadFailed
          ? RecoverableState(
              title: 'Payment page unavailable',
              message:
                  'We could not reach the payment provider. Check your '
                  'connection and try again.',
              actionLabel: 'Try again',
              onAction: _retry,
            )
          : Stack(
              children: [
                WebViewWidget(controller: _controller),
                if (_loading)
                  const Center(
                    child: CircularProgressIndicator(
                      color: AppColors.primaryBright,
                    ),
                  ),
              ],
            ),
    );
  }
}
