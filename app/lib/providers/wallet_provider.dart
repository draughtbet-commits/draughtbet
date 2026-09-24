import 'dart:async';
import 'dart:developer' as developer;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart';
import '../models/wallet.dart';
import '../models/wallet_read.dart';
import '../services/api_client.dart';
import '../services/socket_service.dart';

class WalletState {
  final WalletProjection? projection;
  final TierLimits? tierLimits;
  final List<WalletEntry> transactions;
  final bool isLoading;
  final WalletLoadPhase walletPhase;
  final WalletLoadPhase transactionsPhase;
  final bool isLoadingMore;
  final bool hasMore;
  final int transactionPage;
  final int? totalTransactions;
  final int? totalPages;
  final String? error;

  const WalletState({
    this.projection,
    this.tierLimits,
    this.transactions = const [],
    this.isLoading = false,
    this.walletPhase = WalletLoadPhase.initial,
    this.transactionsPhase = WalletLoadPhase.initial,
    this.isLoadingMore = false,
    this.hasMore = true,
    this.transactionPage = 0,
    this.totalTransactions,
    this.totalPages,
    this.error,
  });

  String? get balance => projection?.availableMinorUnits.toString();

  WalletState copyWith({
    WalletProjection? projection,
    TierLimits? tierLimits,
    List<WalletEntry>? transactions,
    bool? isLoading,
    WalletLoadPhase? walletPhase,
    WalletLoadPhase? transactionsPhase,
    bool? isLoadingMore,
    bool? hasMore,
    int? transactionPage,
    int? totalTransactions,
    int? totalPages,
    String? error,
  }) {
    return WalletState(
      projection: projection ?? this.projection,
      tierLimits: tierLimits ?? this.tierLimits,
      transactions: transactions ?? this.transactions,
      isLoading: isLoading ?? this.isLoading,
      walletPhase: walletPhase ?? this.walletPhase,
      transactionsPhase: transactionsPhase ?? this.transactionsPhase,
      isLoadingMore: isLoadingMore ?? this.isLoadingMore,
      hasMore: hasMore ?? this.hasMore,
      transactionPage: transactionPage ?? this.transactionPage,
      totalTransactions: totalTransactions ?? this.totalTransactions,
      totalPages: totalPages ?? this.totalPages,
      error: error,
    );
  }
}

class WalletNotifier extends StateNotifier<WalletState> {
  final SocketService _socketService;
  final Dio _dio;
  StreamSubscription<Map<String, dynamic>>? _walletUpdatedSubscription;
  bool _walletEventRefreshInFlight = false;
  bool _balanceRequestInFlight = false;
  bool _transactionsRequestInFlight = false;

  WalletNotifier(this._socketService, this._dio) : super(const WalletState()) {
    _initListeners();
  }

  void _initListeners() {
    _walletUpdatedSubscription = _socketService.onWalletUpdated.listen((_) {
      unawaited(_refreshAfterWalletUpdate());
    });
  }

  Future<void> _refreshAfterWalletUpdate() async {
    if (_walletEventRefreshInFlight) return;
    _walletEventRefreshInFlight = true;
    try {
      await Future.wait([
        fetchBalance(silent: true),
        fetchTransactions(silent: true),
      ]);
    } finally {
      _walletEventRefreshInFlight = false;
    }
  }

  Future<void> fetchBalance({bool silent = false}) async {
    if (_balanceRequestInFlight) return;
    _balanceRequestInFlight = true;
    final hasVerifiedBalance = state.projection != null;
    try {
      state = state.copyWith(
        isLoading: !silent && !hasVerifiedBalance,
        walletPhase: !silent && !hasVerifiedBalance
            ? WalletLoadPhase.loading
            : state.walletPhase,
        error: null,
      );
      final response = await _dio.get('/wallet/balance');

      if (response.statusCode == 200) {
        final body = Map<String, dynamic>.from(response.data as Map);
        final projection = WalletProjection.fromJson(body);
        state = state.copyWith(
          projection: projection,
          isLoading: false,
          walletPhase: WalletLoadPhase.ready,
        );
      }
    } catch (_) {
      state = state.copyWith(
        isLoading: false,
        walletPhase: state.projection == null
            ? WalletLoadPhase.unavailable
            : WalletLoadPhase.ready,
        error: 'Balances could not be verified.',
      );
    } finally {
      _balanceRequestInFlight = false;
    }
  }

  Future<void> fetchTierLimits() async {
    try {
      final response = await _dio.get('/wallet/tier-limits');

      if (response.statusCode == 200) {
        final tierLimits = TierLimits.fromJson(response.data);
        state = state.copyWith(tierLimits: tierLimits);
      }
    } catch (e) {
      developer.log(
        'Failed to fetch tier limits',
        name: 'draughtbet.wallet',
        error: e,
      );
    }
  }

  Future<void> fetchTransactions({
    int page = 1,
    int limit = 20,
    bool silent = false,
  }) async {
    if (_transactionsRequestInFlight) return;
    if (page > 1 && (state.isLoadingMore || !state.hasMore)) return;
    _transactionsRequestInFlight = true;
    final hasTransactions = state.transactions.isNotEmpty;
    try {
      state = state.copyWith(
        transactionsPhase: page == 1 && !silent && !hasTransactions
            ? WalletLoadPhase.loading
            : state.transactionsPhase,
        isLoadingMore: page > 1,
        error: null,
      );
      final response = await _dio.get(
        '/wallet/transactions?page=$page&limit=$limit',
      );

      if (response.statusCode == 200) {
        final body = Map<String, dynamic>.from(response.data as Map);
        final List<dynamic> data = body['transactions'] is List
            ? body['transactions'] as List
            : const [];
        final incoming = data
            .whereType<Map>()
            .map(
              (json) => WalletEntry.fromJson(Map<String, dynamic>.from(json)),
            )
            .toList();
        final byId = <String, WalletEntry>{};
        if (page > 1) {
          for (final entry in state.transactions) {
            byId[entry.id] = entry;
          }
        }
        for (final entry in incoming) {
          byId[entry.id] = entry;
        }
        final transactions = byId.values.toList(growable: false);
        final totalPages = (body['totalPages'] as num?)?.toInt() ?? page;
        final total = (body['total'] as num?)?.toInt();
        final serverPage = (body['page'] as num?)?.toInt() ?? page;
        state = state.copyWith(
          transactions: transactions,
          transactionsPhase: transactions.isEmpty
              ? WalletLoadPhase.empty
              : WalletLoadPhase.ready,
          transactionPage: serverPage,
          totalTransactions: total,
          totalPages: totalPages,
          hasMore: serverPage < totalPages,
          isLoadingMore: false,
        );
      }
    } catch (_) {
      state = state.copyWith(
        transactionsPhase: page == 1 && state.transactions.isEmpty
            ? WalletLoadPhase.failure
            : state.transactionsPhase,
        isLoadingMore: false,
        error: 'Transactions could not be loaded.',
      );
    } finally {
      _transactionsRequestInFlight = false;
    }
  }

  Future<void> loadMoreTransactions({int limit = 20}) =>
      fetchTransactions(page: state.transactionPage + 1, limit: limit);

  Future<Map<String, dynamic>?> initiateDeposit(
    int amountMinorUnits,
    String gateway,
  ) async {
    try {
      state = state.copyWith(isLoading: true, error: null);
      final response = await _dio.post(
        '/wallet/deposit-intent',
        data: {'amountMinorUnits': amountMinorUnits, 'gateway': gateway},
      );

      state = state.copyWith(isLoading: false);

      if (response.statusCode == 200) {
        return response.data; // contains authorizationUrl and reference
      }
      return null;
    } catch (e) {
      String errorMessage = 'Deposit failed';
      if (e is DioException && e.response?.data != null) {
        errorMessage = e.response!.data['error'] ?? errorMessage;
      }
      state = state.copyWith(isLoading: false, error: errorMessage);
      return null;
    }
  }

  Future<bool> requestWithdrawal(int amountMinorUnits) async {
    try {
      state = state.copyWith(isLoading: true, error: null);
      final response = await _dio.post(
        '/wallet/withdrawal-request',
        data: {'amountMinorUnits': amountMinorUnits},
      );

      state = state.copyWith(isLoading: false);

      if (response.statusCode == 201) {
        // Fetch updated balance and transactions
        fetchBalance();
        fetchTransactions();
        return true;
      }
      return false;
    } catch (e) {
      String errorMessage = 'Withdrawal failed';
      if (e is DioException && e.response?.data != null) {
        errorMessage = e.response!.data['error'] ?? errorMessage;
      }
      state = state.copyWith(isLoading: false, error: errorMessage);
      return false;
    }
  }

  @override
  void dispose() {
    _walletUpdatedSubscription?.cancel();
    super.dispose();
  }
}

final walletProvider = StateNotifierProvider<WalletNotifier, WalletState>((
  ref,
) {
  return WalletNotifier(socketService, ref.watch(apiClientProvider));
});
