import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import '../theme/colors.dart';
import '../theme/typography.dart';

enum CheckoutExit { returned }

class CheckoutWebviewScreen extends StatefulWidget {
  final Uri authorizationUrl;

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
            // A provider URL is never evidence of payment success. Every
            // navigation remains inside checkout until the user returns to
            // the app, which then reads authoritative status from the API.
            return NavigationDecision.navigate;
          },
        ),
      )
      ..loadRequest(widget.authorizationUrl);
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
          onPressed: () => Navigator.of(context).pop(CheckoutExit.returned),
        ),
      ),
      body: WebViewWidget(controller: _controller),
    );
  }
}
