// App-wide state fed by the engine's push events (desktop: api.onTorrents / onToast).

import 'dart:async';

import 'package:flutter/material.dart';

import 'bridge.dart';
import 'l10n.dart';
import 'store.dart';
import 'ui/toast.dart';

class AppState extends ChangeNotifier {
  AppState._();
  static final instance = AppState._();

  List<Torrent> torrents = const [];
  Totals totals = const Totals(0, 0);
  Map<String, Object?> prefs = const {};
  bool pip = false;
  StreamSubscription<Object?>? _sub;

  /// Hooks the library sets up: adding from a magnet link opened in another app, media keys.
  void Function(String id)? onOpen;
  void Function(String action)? onMediaAction;

  Torrent? byHash(String ih) {
    for (final t in torrents) {
      if (t.infoHash == ih) return t;
    }
    return null;
  }

  /// Any torrent downloading or fetching details: drives the brand mark's breathing piece.
  bool get active => torrents.any((t) => t.status == 'downloading' || t.status == 'metadata');

  Future<void> start() async {
    prefs = (await Api.call<Map<Object?, Object?>>('prefs:get'))!.map((k, v) => MapEntry('$k', v));
    _sub = Api.events.listen(_onEvent);
    // Android 13+: the background-download notification needs permission. Ask once.
    if (Store.get('askedNotifications') != true) {
      Store.set('askedNotifications', true);
      Api.call('app:requestNotifications');
    }
    for (final id in (await Api.call<List<Object?>>('app:pendingOpens')) ?? const []) {
      onOpen?.call('$id');
    }
  }

  void _onEvent(Map<Object?, Object?> e) {
    switch (e['type']) {
      case 'torrents':
        torrents = ((e['torrents'] as List?) ?? const []).map((m) => Torrent((m as Map).cast())).toList();
        final tot = (e['totals'] as Map?) ?? const {};
        totals = Totals((tot['down'] as num?)?.toInt() ?? 0, (tot['up'] as num?)?.toInt() ?? 0);
        notifyListeners();
      case 'toast':
        final vars = (e['vars'] as Map?)?.map((k, v) => MapEntry('$k', v));
        Toasts.show(t(e['message'] as String? ?? '', vars), error: e['tone'] == 'error');
      case 'open':
        onOpen?.call(e['id'] as String);
      case 'media':
        onMediaAction?.call(e['action'] as String);
      case 'pip':
        pip = e['active'] == true;
        notifyListeners();
    }
  }

  /// Redraw listeners after a UI-only change (e.g. Continue watching edited).
  void refresh() => notifyListeners();

  Future<void> setPrefs(Map<String, Object?> patch) async {
    prefs = {...prefs, ...patch};
    notifyListeners();
    final r = await Api.call<Map<Object?, Object?>>('prefs:set', [patch]);
    if (r != null) prefs = r.map((k, v) => MapEntry('$k', v));
    notifyListeners();
  }

  Future<void> reloadPrefs() async {
    prefs = (await Api.call<Map<Object?, Object?>>('prefs:get'))!.map((k, v) => MapEntry('$k', v));
    notifyListeners();
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}

/// Runs an engine call and shows any error as an error toast (desktop run()).
Future<T?> run<T>(Future<T?> f) async {
  try {
    return await f;
  } catch (e) {
    Toasts.show('$e', error: true);
    return null;
  }
}
