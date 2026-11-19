// UI state the desktop renderer kept in localStorage (sortBy, view, recent, pos:…, subStyle, …),
// JSON-encoded under the same keys.

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

abstract final class Store {
  static late SharedPreferences _p;

  static Future<void> init() async => _p = await SharedPreferences.getInstance();

  static Object? get(String key) {
    final raw = _p.getString(key);
    if (raw == null) return null;
    try {
      return jsonDecode(raw);
    } catch (_) {
      return null;
    }
  }

  static void set(String key, Object? value) =>
      value == null ? _p.remove(key) : _p.setString(key, jsonEncode(value));

  static void remove(String key) => _p.remove(key);
}

/// One "Continue watching" entry: {ih, index, t, d, at, name}.
class RecentWatch {
  RecentWatch(this.ih, this.index, this.t, this.d, this.at, this.name);
  final String ih, name;
  final int index, at;
  final double t, d;

  Map<String, Object?> toJson() => {'ih': ih, 'index': index, 't': t, 'd': d, 'at': at, 'name': name};

  static RecentWatch? fromJson(Object? o) {
    if (o is! Map) return null;
    final t = (o['t'] as num?)?.toDouble(), d = (o['d'] as num?)?.toDouble();
    if (o['ih'] is! String || t == null || !t.isFinite || d == null || d <= 0) return null;
    return RecentWatch(o['ih'] as String, (o['index'] as num?)?.toInt() ?? 0, t, d, (o['at'] as num?)?.toInt() ?? 0,
        o['name'] as String? ?? '');
  }
}

abstract final class Recent {
  static List<RecentWatch> list() =>
      ((Store.get('recent') as List?) ?? const []).map(RecentWatch.fromJson).whereType<RecentWatch>().toList();

  /// One entry per torrent; only positions between 5 s in and 15 s before the end count. Max 20.
  static void remember(String ih, int index, double t, double d, String name) {
    final l = list().where((r) => r.ih != ih).toList();
    if (t > 5 && t < d - 15) l.insert(0, RecentWatch(ih, index, t, d, DateTime.now().millisecondsSinceEpoch, name));
    Store.set('recent', l.take(20).map((r) => r.toJson()).toList());
  }

  static void forget(String ih) => Store.set('recent', list().where((r) => r.ih != ih).map((r) => r.toJson()).toList());
}
