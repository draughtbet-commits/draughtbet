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
      error: error,
    );
  }
}

class WalletNotifier extends StateNotifier<WalletState> {
  final SocketService _socketService;
  final Dio _dio;

  WalletNotifier(this._socketService, this._dio) : super(const WalletState()) {
    _initListeners();
  }

  void _initListeners() {
    _socketService.onWalletUpdated.listen((data) {
      if (data['balance'] != null) {
        final payload = Map<String, dynamic>.from(data);
        state = state.copyWith(
          projection: WalletProjection.fromJson(payload),
          walletPhase: WalletLoadPhase.ready,
        );
      }
      // Re-fetch transactions to get the new entry
      fetchTransactions();
    });
  }

  Future<void> fetchBalance() async {
    try {
      state = state.copyWith(
        isLoading: true,
        walletPhase: WalletLoadPhase.loading,
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
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        walletPhase: state.projection == null
            ? WalletLoadPhase.unavailable
            : WalletLoadPhase.ready,
        error: 'Balances could not be verified.',
      );
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

  Future<void> fetchTransactions({int page = 1, int limit = 20}) async {
    if (page > 1 && (state.isLoadingMore || !state.hasMore)) return;
    try {
      state = state.copyWith(
        transactionsPhase: page == 1
            ? WalletLoadPhase.loading
            : state.transactionsPhase,
        isLoadingMore: page > 1,
        error: null,
      );
      final response = await _dio.get(
        '/wallet/transactions?page=$page&limit=$limit',
      );

      if (response.statusCode == 200) {
        final List<dynamic> data = response.data['transactions'] ?? [];
        final incoming = data
            .whereType<Map>()
            .map(
              (json) => WalletEntry.fromJson(Map<String, dynamic>.from(json)),
            )
            .toList();
        final transactions = page == 1
            ? incoming
            : [...state.transactions, ...incoming];
        state = state.copyWith(
          transactions: transactions,
          transactionsPhase: transactions.isEmpty
              ? WalletLoadPhase.empty
              : WalletLoadPhase.ready,
          transactionPage: page,
          hasMore: incoming.length >= limit,
          isLoadingMore: false,
        );
      }
    } catch (e) {
      state = state.copyWith(
        transactionsPhase: page == 1
            ? WalletLoadPhase.failure
            : state.transactionsPhase,
        isLoadingMore: false,
        error: 'Transactions could not be loaded.',
      );
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
}

final walletProvider = StateNotifierProvider<WalletNotifier, WalletState>((
  ref,
) {
  return WalletNotifier(socketService, ref.watch(apiClientProvider));
});
