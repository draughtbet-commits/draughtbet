import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import '../providers/ui_providers.dart';
import '../theme/colors.dart';

class LandingPage extends ConsumerStatefulWidget {
  static const String route = '/landing';

  const LandingPage({Key? key}) : super(key: key);

  @override
  ConsumerState<LandingPage> createState() => _LandingPageState();
}

class _LandingPageState extends ConsumerState<LandingPage> {
  final PageController _controller = PageController();
  int _index = 0;
  bool _showWelcome = false;
  bool _loading = true;

  static const List<String> _images = [
    'assets/images/splash.jpg',
    'assets/images/onboarding1.jpg',
    'assets/images/onboarding2.jpg',
    'assets/images/onboarding3.jpg',
  ];

  @override
  void initState() {
    super.initState();
    // Follow the live in-session flag (set by _finishOnboarding), then restore
    // the persisted value so returning users skip the carousel on cold start.
    _showWelcome = ref.read(landingWelcomeShownProvider);
    Future.microtask(() async {
      final notifier = ref.read(landingWelcomeShownProvider.notifier);
      await notifier.ensureLoaded();
      if (!mounted) return;
      setState(() {
        _showWelcome = ref.read(landingWelcomeShownProvider);
        _loading = false;
      });
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _next() {
    if (_index < _images.length - 1) {
      _controller.nextPage(
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeInOut,
      );
    }
  }

  void _finishOnboarding() {
    ref.read(landingWelcomeShownProvider.notifier).complete();
    setState(() => _showWelcome = true);
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      // Hold on a void frame until the persisted onboarding flag is restored,
      // so returning users never glimpse the carousel.
      return const Scaffold(backgroundColor: AppColors.voidBg);
    }
    if (_showWelcome) {
      return const WelcomeView();
    }
    return Scaffold(
      backgroundColor: AppColors.voidBg,
      body: SafeArea(
        child: Stack(
          children: [
            Positioned(
              top: -120,
              right: -80,
              child: Container(
                width: 280,
                height: 280,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: RadialGradient(
                    colors: [
                      AppColors.brand.withValues(alpha: 0.10),
                      AppColors.brand.withValues(alpha: 0.0),
                    ],
                  ),
                ),
              ),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_index > 0)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(24, 8, 16, 0),
                    child: Align(
                      alignment: Alignment.centerRight,
                      child: TextButton(
                        onPressed: _finishOnboarding,
                        child: Text(
                          'Skip',
                          style: GoogleFonts.inter(
                            fontSize: 15,
                            fontWeight: FontWeight.w500,
                            color: AppColors.textMuted,
                          ),
                        ),
                      ),
                    ),
                  ),
                Expanded(
                  child: PageView.builder(
                    controller: _controller,
                    itemCount: _images.length,
                    onPageChanged: (i) => setState(() => _index = i),
                    itemBuilder: (context, i) {
                      if (i == 0) {
                        return const SplashSlide();
                      }
                      return OnboardingSlide(
                        image: _images[i],
                        index: i,
                        total: _images.length,
                        currentIndex: _index,
                        onNext: _next,
                        onFinish: _finishOnboarding,
                      );
                    },
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class SplashSlide extends StatelessWidget {
  const SplashSlide({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final wordmark = RichText(
      textAlign: TextAlign.center,
      text: TextSpan(
        style: GoogleFonts.sora(
          fontSize: 44,
          fontWeight: FontWeight.w700,
          letterSpacing: 4,
          height: 1.15,
        ),
        children: const [
          TextSpan(text: 'DRAUGHT\n', style: TextStyle(color: AppColors.textPrimary)),
          TextSpan(text: 'BET', style: TextStyle(color: Color(0xFF18C986))),
        ],
      ),
    );

    // Everything sits on the dark background. The image is a distinct block
    // that flexes to fill the available space; wordmark + tagline sit below it
    // on the dark page, not over the image.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 24),
        Expanded(
          child: FlexibleArtwork(image: 'assets/images/splash.jpg'),
        ),
        const SizedBox(height: 24),
        wordmark,
        const SizedBox(height: 16),
        Text(
          'Play smart. Compete fairly',
          textAlign: TextAlign.center,
          style: GoogleFonts.inter(
            fontSize: 15,
            fontWeight: FontWeight.w400,
            color: AppColors.textMuted,
            letterSpacing: 0.3,
          ),
        ),
        const SizedBox(height: 32),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: List.generate(3, (_) {
            return Container(
              width: 8,
              height: 8,
              margin: const EdgeInsets.symmetric(horizontal: 4),
              decoration: BoxDecoration(
                color: AppColors.textMuted.withValues(alpha: 0.4),
                shape: BoxShape.circle,
              ),
            );
          }),
        ),
        const SizedBox(height: 16),
      ],
    );
  }
}

class OnboardingSlide extends StatelessWidget {
  final String image;
  final int index;
  final int total;
  final int currentIndex;
  final VoidCallback onNext;
  final VoidCallback onFinish;
  const OnboardingSlide({
    Key? key,
    required this.image,
    required this.index,
    required this.total,
    required this.currentIndex,
    required this.onNext,
    required this.onFinish,
  }) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final String title;
    final String subtitle;
    if (index == 1) {
      title = 'Your skill.\nYour match.';
      subtitle = 'Compete against real\nplayers in live\ndraught matches.';
    } else if (index == 2) {
      title = 'Every move\ncounts.';
      subtitle = 'Matches follow verified\nrules and server controlled\ngame logic';
    } else {
      title = 'Know where\nyour money\ngoes';
      subtitle = 'See your stake, payout\nand settlement clearly\nbefore and after every\nmatch';
    }

    return Column(
      children: [
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.topLeft,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: GoogleFonts.sora(
                    fontSize: 28,
                    fontWeight: FontWeight.w700,
                    height: 1.2,
                    color: AppColors.textPrimary,
                  ),
                ),
                const SizedBox(height: 10),
                Text(
                  subtitle,
                  style: GoogleFonts.inter(
                    fontSize: 15,
                    fontWeight: FontWeight.w400,
                    height: 1.4,
                    color: AppColors.textMuted,
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 24),
        // Image flexes to fill the remaining space so nothing overflows.
        Expanded(
          child: FlexibleArtwork(
            image: image,
            fadeStrength: 0.9,
            fadeHeight: 110,
          ),
        ),
        const SizedBox(height: 16),
        if (index == total - 1)
          // Last onboarding slide: green "Get Started" CTA replaces the slide
          // indicator and the Next button.
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: SizedBox(
              width: double.infinity,
              height: 52,
              child: ElevatedButton(
                onPressed: onFinish,
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.brand,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
                child: Text(
                  'Get Started',
                  style: GoogleFonts.inter(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ),
          )
        else ...[
          // Swipe dots above the Next button.
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: List.generate(total, (i) {
              final active = i == currentIndex;
              return AnimatedContainer(
                duration: const Duration(milliseconds: 250),
                margin: const EdgeInsets.symmetric(horizontal: 4),
                width: active ? 22 : 8,
                height: 8,
                decoration: BoxDecoration(
                  color: active ? AppColors.brand : AppColors.textMuted.withValues(alpha: 0.4),
                  borderRadius: BorderRadius.circular(4),
                ),
              );
            }),
          ),
          const SizedBox(height: 16),
          // Next button: green border, black background, white text.
          Align(
            alignment: Alignment.centerRight,
            child: Padding(
              padding: const EdgeInsets.only(right: 24),
              child: OutlinedButton(
                onPressed: onNext,
                style: OutlinedButton.styleFrom(
                  backgroundColor: AppColors.voidBg,
                  foregroundColor: AppColors.textPrimary,
                  side: BorderSide(color: AppColors.brand, width: 1.5),
                  padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 14),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
                child: Text(
                  'Next',
                  style: GoogleFonts.inter(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ),
          ),
        ],
        const SizedBox(height: 24),
      ],
    );
  }
}

class FlexibleArtwork extends StatelessWidget {
  final String image;
  final double fadeStrength;
  final double fadeHeight;
  const FlexibleArtwork({
    Key? key,
    required this.image,
    this.fadeStrength = 0.6,
    this.fadeHeight = 60,
  }) : super(key: key);

  @override
  Widget build(BuildContext context) {
    // Full-width image (no rounding) that fills its parent. BoxFit.cover
    // crops generously and reveals the surrounding dark page texture on top
    // and bottom via soft fades. Works at any screen size.
    return ClipRect(
      child: Stack(
        children: [
          Positioned.fill(
            child: Image.asset(image, fit: BoxFit.cover),
          ),
          Positioned(
            left: 0, right: 0, top: 0, height: fadeHeight,
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [
                    AppColors.voidBg.withValues(alpha: fadeStrength),
                    AppColors.voidBg.withValues(alpha: 0.0),
                  ],
                ),
              ),
            ),
          ),
          Positioned(
            left: 0, right: 0, bottom: 0, height: fadeHeight,
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.bottomCenter,
                  end: Alignment.topCenter,
                  colors: [
                    AppColors.voidBg.withValues(alpha: fadeStrength),
                    AppColors.voidBg.withValues(alpha: 0.0),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class WelcomeView extends StatelessWidget {
  const WelcomeView({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.voidBg,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // A little dark page at the top, then the hero artwork.
            const SizedBox(height: 32),
            Expanded(
              child: FlexibleArtwork(
                image: 'assets/images/landingpage.jpg',
                fadeStrength: 0.9,
                fadeHeight: 110,
              ),
            ),
            const SizedBox(height: 32),
            // Centered words.
            Text(
              'Play draughts.',
              textAlign: TextAlign.center,
              style: GoogleFonts.sora(
                fontSize: 32,
                fontWeight: FontWeight.w700,
                height: 1.2,
                color: AppColors.textPrimary,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              'Prove your skill.',
              textAlign: TextAlign.center,
              style: GoogleFonts.sora(
                fontSize: 22,
                fontWeight: FontWeight.w600,
                height: 1.2,
                color: AppColors.textPrimary,
              ),
            ),
            const SizedBox(height: 32),
            // CTAs centered: Create Account (green), Sign In (black).
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Column(
                children: [
                  SizedBox(
                    width: double.infinity,
                    height: 52,
                    child: ElevatedButton(
                      onPressed: () => context.go('/register'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.brand,
                        foregroundColor: Colors.white,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                      child: Text(
                        'Create Account',
                        style: GoogleFonts.inter(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),
                  SizedBox(
                    width: double.infinity,
                    height: 52,
                    child: OutlinedButton(
                      onPressed: () => context.go('/login'),
                      style: OutlinedButton.styleFrom(
                        backgroundColor: AppColors.voidBg,
                        foregroundColor: AppColors.textPrimary,
                        side: const BorderSide(color: Colors.white24, width: 1.5),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                      ),
                      child: Text(
                        'Sign In',
                        style: GoogleFonts.inter(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 32),
          ],
        ),
      ),
    );
  }
}
