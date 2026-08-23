import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:go_router/go_router.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';

class CheckoutWebviewScreen extends StatefulWidget {
  final String authorizationUrl;

  const CheckoutWebviewScreen({super.key, required this.authorizationUrl});

  @override
  State<CheckoutWebviewScreen> createState() => _CheckoutWebviewScreenState();
}

class _CheckoutWebviewScreenState extends State<CheckoutWebviewScreen> {
  late final WebViewController _controller;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(AppColors.voidBg)
      ..setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (NavigationRequest request) {
            // In a real app, you would check if the redirect URL matches your webhook/callback
            // to automatically close the webview. For now, the user can manually close or
            // rely on the wallet_updated socket event.
            if (request.url.contains('callback') || request.url.contains('success')) {
              context.pop();
              return NavigationDecision.prevent;
            }
            return NavigationDecision.navigate;
          },
        ),
      )
      ..loadRequest(Uri.parse(widget.authorizationUrl));
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
          onPressed: () => context.pop(),
        ),
      ),
      body: WebViewWidget(controller: _controller),
    );
  }
}
