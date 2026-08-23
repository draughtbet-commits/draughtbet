import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import '../models/wallet.dart';
import '../models/wallet_transaction.dart';
import '../services/socket_service.dart';

class WalletState {
  final String? balance;
  final TierLimits? tierLimits;
  final List<WalletTransaction> transactions;
  final bool isLoading;
  final String? error;

  const WalletState({
    this.balance,
    this.tierLimits,
    this.transactions = const [],
    this.isLoading = false,
    this.error,
  });

  WalletState copyWith({
    String? balance,
    TierLimits? tierLimits,
    List<WalletTransaction>? transactions,
    bool? isLoading,
    String? error,
  }) {
    return WalletState(
      balance: balance ?? this.balance,
      tierLimits: tierLimits ?? this.tierLimits,
      transactions: transactions ?? this.transactions,
      isLoading: isLoading ?? this.isLoading,
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
        state = state.copyWith(balance: data['balance'].toString());
      }
      // Re-fetch transactions to get the new entry
      fetchTransactions();
    });
  }

  Future<void> fetchBalance() async {
    try {
      state = state.copyWith(isLoading: true, error: null);
      final storage = const FlutterSecureStorage();
      final token = await storage.read(key: 'jwt');
      final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';

      final response = await _dio.get(
        '$backendUrl/wallet/balance',
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      );

      if (response.statusCode == 200) {
        final balance = response.data['balance']?.toString();
        state = state.copyWith(balance: balance, isLoading: false);
      }
    } catch (e) {
      state = state.copyWith(isLoading: false, error: 'Failed to fetch balance: $e');
    }
  }

  Future<void> fetchTierLimits() async {
    try {
      final storage = const FlutterSecureStorage();
      final token = await storage.read(key: 'jwt');
      final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';

      final response = await _dio.get(
        '$backendUrl/wallet/tier-limits',
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      );

      if (response.statusCode == 200) {
        final tierLimits = TierLimits.fromJson(response.data);
        state = state.copyWith(tierLimits: tierLimits);
      }
    } catch (e) {
      print('Failed to fetch tier limits: $e');
    }
  }

  Future<void> fetchTransactions({int page = 1, int limit = 20}) async {
    try {
      final storage = const FlutterSecureStorage();
      final token = await storage.read(key: 'jwt');
      final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';

      final response = await _dio.get(
        '$backendUrl/wallet/transactions?page=$page&limit=$limit',
        options: Options(headers: {'Authorization': 'Bearer $token'}),
      );

      if (response.statusCode == 200) {
        final List<dynamic> data = response.data['transactions'] ?? [];
        final transactions = data.map((json) => WalletTransaction.fromJson(json)).toList();
        state = state.copyWith(transactions: transactions);
      }
    } catch (e) {
      print('Failed to fetch transactions: $e');
    }
  }

  Future<Map<String, dynamic>?> initiateDeposit(int amountMinorUnits, String gateway) async {
    try {
      state = state.copyWith(isLoading: true, error: null);
      final storage = const FlutterSecureStorage();
      final token = await storage.read(key: 'jwt');
      final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';

      final response = await _dio.post(
        '$backendUrl/wallet/deposit-intent',
        data: {'amountMinorUnits': amountMinorUnits, 'gateway': gateway},
        options: Options(headers: {'Authorization': 'Bearer $token'}),
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
      final storage = const FlutterSecureStorage();
      final token = await storage.read(key: 'jwt');
      final backendUrl = dotenv.env['BACKEND_URL'] ?? 'http://localhost:3000';

      final response = await _dio.post(
        '$backendUrl/wallet/withdrawal-request',
        data: {'amountMinorUnits': amountMinorUnits},
        options: Options(headers: {'Authorization': 'Bearer $token'}),
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

final walletProvider = StateNotifierProvider<WalletNotifier, WalletState>((ref) {
  final dio = Dio();
  return WalletNotifier(socketService, dio);
});
