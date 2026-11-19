// Toasts (web-app/renderer/app.js toast()): bottom-centre, info 3.5 s, error 6 s, paused while touched.

import 'dart:async';

import 'package:flutter/material.dart';

import '../theme.dart';

class _Toast {
  _Toast(this.message, this.error);
  final String message;
  final bool error;
  final key = UniqueKey();
}

abstract final class Toasts {
  static final _items = ValueNotifier<List<_Toast>>([]);

  static void show(String message, {bool error = false}) {
    if (message.trim().isEmpty) return;
    _items.value = [..._items.value, _Toast(message, error)];
  }

  static void _remove(_Toast t) => _items.value = _items.value.where((x) => x != t).toList();
}

/// Put once above the navigator (MaterialApp.builder).
class ToastHost extends StatelessWidget {
  const ToastHost({super.key});

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.paddingOf(context).bottom + 18;
    return Positioned(
      left: 16,
      right: 16,
      bottom: bottom,
      child: ValueListenableBuilder(
        valueListenable: Toasts._items,
        builder: (context, items, _) => Column(
          mainAxisSize: MainAxisSize.min,
          children: [for (final t in items) _ToastView(key: t.key, toast: t)],
        ),
      ),
    );
  }
}

class _ToastView extends StatefulWidget {
  const _ToastView({super.key, required this.toast});
  final _Toast toast;

  @override
  State<_ToastView> createState() => _ToastViewState();
}

class _ToastViewState extends State<_ToastView> with SingleTickerProviderStateMixin {
  late final _anim = AnimationController(vsync: this, duration: const Duration(milliseconds: 300))..forward();
  Timer? _timer;
  late int _left = widget.toast.error ? 6000 : 3500;
  DateTime _started = DateTime.now();

  @override
  void initState() {
    super.initState();
    _arm();
  }

  void _arm() {
    _started = DateTime.now();
    _timer = Timer(Duration(milliseconds: _left), _leave);
  }

  void _hold() {
    _timer?.cancel();
    _left -= DateTime.now().difference(_started).inMilliseconds;
  }

  Future<void> _leave() async {
    _anim.duration = const Duration(milliseconds: 150);
    await _anim.reverse();
    Toasts._remove(widget.toast);
  }

  @override
  void dispose() {
    _timer?.cancel();
    _anim.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final err = widget.toast.error;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: FadeTransition(
        opacity: _anim,
        child: SlideTransition(
          position: Tween(begin: const Offset(0, .6), end: Offset.zero).animate(CurvedAnimation(parent: _anim, curve: Curves.ease)),
          child: GestureDetector(
            onTapDown: (_) => _hold(),
            onTapUp: (_) => _arm(),
            onTapCancel: _arm,
            onTap: _leave,
            child: Container(
              constraints: const BoxConstraints(maxWidth: 520),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: p.surface2,
                borderRadius: BorderRadius.circular(Tokens.rMd),
                border: Border.all(color: err ? p.danger.withValues(alpha: .55) : p.line),
                boxShadow: [p.shadow],
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (err) ...[
                    Container(width: 7, height: 7, decoration: BoxDecoration(color: p.danger, borderRadius: BorderRadius.circular(2))),
                    const SizedBox(width: 8),
                  ],
                  Flexible(
                    child: Text(widget.toast.message,
                        style: TextStyle(color: p.text, fontSize: Tokens.fsSm, decoration: TextDecoration.none, fontFamily: Tokens.font)),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
