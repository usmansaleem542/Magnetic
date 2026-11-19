// Components from web-app/renderer/styles.css, sized for touch: buttons, segmented control,
// select, fields, the gold piece strip, the brand mark, spinner, sheets and menus.

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../l10n.dart';
import '../theme.dart';
import 'icons.dart';

// ------------------------------------------------------------------ buttons

enum BtnKind { primary, ghost, danger }

/// `.btn`: primary (gold), ghost (surface), danger (ghost with danger text). Press scales to .97.
class Btn extends StatelessWidget {
  const Btn(this.label, {super.key, this.onTap, this.kind = BtnKind.ghost, this.icon, this.small = false, this.inDialog = false, this.expand = false});
  final String label;
  final VoidCallback? onTap;
  final BtnKind kind;
  final String? icon;
  final bool small, inDialog, expand;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final bg = switch (kind) {
      BtnKind.primary => p.accent,
      _ => inDialog ? p.surface2 : p.surface,
    };
    final fg = switch (kind) {
      BtnKind.primary => p.accentInk,
      BtnKind.danger => p.danger,
      BtnKind.ghost => p.text,
    };
    final child = Row(
      mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (icon != null) ...[MIcon(icon!, size: small ? 15 : 17, color: fg), const SizedBox(width: 7)],
        Flexible(
          child: Text(label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: fg, fontSize: Tokens.fsSm, fontWeight: FontWeight.w600)),
        ),
      ],
    );
    return Pressable(
      onTap: onTap,
      child: Opacity(
        opacity: onTap == null ? .45 : 1,
        child: Container(
          height: small ? 32 : 40,
          padding: EdgeInsets.symmetric(horizontal: small ? 11 : 16),
          decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(Tokens.rSm)),
          child: child,
        ),
      ),
    );
  }
}

/// `.btn-icon`: square, muted icon; [on] turns it gold (player toggles).
class IconBtn extends StatelessWidget {
  const IconBtn(this.icon, {super.key, this.onTap, this.tooltip, this.size = 40, this.iconSize = 20, this.color, this.mirror = false, this.on = false, this.background});
  final String icon;
  final VoidCallback? onTap;
  final String? tooltip;
  final double size, iconSize;
  final Color? color, background;
  final bool mirror, on;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final c = on ? p.gold : (color ?? p.muted);
    Widget w = Pressable(
      onTap: onTap,
      scale: .92,
      child: Opacity(
        opacity: onTap == null ? .45 : 1,
        child: Container(
          width: size,
          height: size,
          alignment: Alignment.center,
          decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(size / 2)),
          child: MIcon(icon, size: iconSize, color: c, mirror: mirror),
        ),
      ),
    );
    if (tooltip != null) w = Semantics(label: tooltip, button: true, child: Tooltip(message: tooltip!, child: w));
    return w;
  }
}

/// Press feedback: scale(0.97) over 160 ms ease-out, like `.btn:active`.
class Pressable extends StatefulWidget {
  const Pressable({super.key, required this.child, this.onTap, this.onLongPress, this.scale = .97});
  final Widget child;
  final VoidCallback? onTap, onLongPress;
  final double scale;

  @override
  State<Pressable> createState() => _PressableState();
}

class _PressableState extends State<Pressable> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.disableAnimationsOf(context);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: widget.onTap,
      onLongPress: widget.onLongPress,
      onTapDown: widget.onTap == null ? null : (_) => setState(() => _down = true),
      onTapUp: (_) => setState(() => _down = false),
      onTapCancel: () => setState(() => _down = false),
      child: AnimatedScale(
        scale: _down && !reduce ? widget.scale : 1,
        duration: const Duration(milliseconds: 160),
        curve: Tokens.easeOut,
        child: widget.child,
      ),
    );
  }
}

// ------------------------------------------------------------------ segmented / select / fields

class Segment<T> {
  const Segment(this.value, {this.icon, this.label, this.tooltip});
  final T value;
  final String? icon, label, tooltip;
}

/// `.segmented`: 2px padded track, selected segment raised to surface-2.
class Segmented<T> extends StatelessWidget {
  const Segmented({super.key, required this.value, required this.segments, required this.onChanged, this.inDialog = false, this.dark = false});
  final T value;
  final List<Segment<T>> segments;
  final ValueChanged<T> onChanged;
  final bool inDialog, dark;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final track = dark ? Colors.white.withValues(alpha: .05) : (inDialog ? p.surface2 : p.surface);
    final selected = dark ? Colors.white.withValues(alpha: .14) : (inDialog ? p.surface : p.surface2);
    return Container(
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        color: track,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: inDialog || dark ? Colors.transparent : p.line),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final s in segments)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 1),
              child: Semantics(
                selected: s.value == value,
                button: true,
                label: s.tooltip ?? s.label,
                child: Pressable(
                  scale: .95,
                  onTap: () => onChanged(s.value),
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 150),
                    height: s.label != null ? 32 : 30,
                    padding: EdgeInsets.symmetric(horizontal: s.label != null ? 14 : 9),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: s.value == value ? selected : Colors.transparent,
                      borderRadius: BorderRadius.circular(6),
                      boxShadow: s.value == value && inDialog ? const [BoxShadow(color: Color(0x40000000), blurRadius: 2, offset: Offset(0, 1))] : null,
                    ),
                    child: s.icon != null
                        ? MIcon(s.icon!, size: 17, color: s.value == value ? (dark ? Colors.white : p.text) : (dark ? const Color(0xFFA3A3A3) : p.muted))
                        : Text(s.label!,
                            style: TextStyle(
                                fontSize: dark ? Tokens.fsXs : Tokens.fsSm,
                                fontWeight: FontWeight.w600,
                                color: s.value == value ? (dark ? Colors.white : p.text) : (dark ? const Color(0xFFA3A3A3) : p.muted))),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class SelectOption<T> {
  const SelectOption(this.value, this.label);
  final T value;
  final String label;
}

/// `.select`: bordered box with a chevron; opens our menu.
class Select<T> extends StatelessWidget {
  const Select({super.key, required this.value, required this.options, required this.onChanged, this.width});
  final T value;
  final List<SelectOption<T>> options;
  final ValueChanged<T> onChanged;
  final double? width;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final current = options.firstWhere((o) => o.value == value, orElse: () => options.first);
    return Builder(builder: (ctx) {
      return Pressable(
        onTap: () async {
          final box = ctx.findRenderObject() as RenderBox;
          final pos = box.localToGlobal(Offset.zero);
          final r = await showMenu<T>(
            context: ctx,
            position: RelativeRect.fromLTRB(pos.dx, pos.dy + box.size.height + 6, pos.dx + box.size.width, 0),
            items: [
              for (final o in options)
                PopupMenuItem(
                  value: o.value,
                  height: 42,
                  child: Row(children: [
                    Expanded(child: Text(o.label, style: TextStyle(fontSize: Tokens.fsSm, color: p.text))),
                    if (o.value == value) MIcon('check', size: 16, color: p.gold),
                  ]),
                ),
            ],
          );
          if (r != null) onChanged(r);
        },
        child: Container(
          height: 38,
          width: width,
          padding: const EdgeInsetsDirectional.only(start: 12, end: 8),
          decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(Tokens.rSm), border: Border.all(color: p.line)),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Flexible(child: Text(current.label, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: Tokens.fsSm, color: p.text))),
            const SizedBox(width: 6),
            Transform.rotate(angle: math.pi / 2, child: MIcon('chevron', size: 14, color: p.muted)),
          ]),
        ),
      );
    });
  }
}

/// Text input: 1px line border, gold on focus, faint placeholder.
class Field extends StatelessWidget {
  const Field({
    super.key, this.controller, this.hint, this.onSubmitted, this.onChanged, this.prefix, this.suffix, this.obscure = false,
    this.maxLines = 1, this.keyboardType, this.textDirection, this.height = 42, this.background, this.autofocus = false, this.focusNode, this.textAlign = TextAlign.start,
  });
  final TextEditingController? controller;
  final String? hint;
  final ValueChanged<String>? onSubmitted, onChanged;
  final Widget? prefix, suffix;
  final bool obscure, autofocus;
  final int maxLines;
  final TextInputType? keyboardType;
  final TextDirection? textDirection;
  final double height;
  final Color? background;
  final FocusNode? focusNode;
  final TextAlign textAlign;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final border = OutlineInputBorder(borderRadius: BorderRadius.circular(Tokens.rSm), borderSide: BorderSide(color: p.line));
    return SizedBox(
      height: maxLines == 1 ? height : null,
      child: TextField(
        controller: controller,
        focusNode: focusNode,
        autofocus: autofocus,
        obscureText: obscure,
        maxLines: maxLines,
        minLines: maxLines > 1 ? maxLines : null,
        keyboardType: keyboardType,
        textDirection: textDirection,
        textAlign: textAlign,
        textAlignVertical: TextAlignVertical.center,
        onSubmitted: onSubmitted,
        onChanged: onChanged,
        autocorrect: false,
        enableSuggestions: false,
        style: TextStyle(fontSize: maxLines > 1 ? Tokens.fsXs : Tokens.fsSm, color: p.text, height: maxLines > 1 ? 1.6 : null),
        decoration: InputDecoration(
          isDense: true,
          filled: true,
          fillColor: background ?? p.surface,
          hintText: hint,
          hintStyle: TextStyle(color: p.faint, fontSize: Tokens.fsSm),
          prefixIcon: prefix,
          prefixIconConstraints: BoxConstraints(minWidth: 36, minHeight: maxLines == 1 ? height - 2 : 20),
          suffixIconConstraints: BoxConstraints(minWidth: 40, minHeight: maxLines == 1 ? height - 2 : 20),
          suffixIcon: suffix,
          contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: maxLines > 1 ? 10 : (height - 20) / 2),
          border: border,
          enabledBorder: border,
          focusedBorder: border.copyWith(borderSide: BorderSide(color: p.gold)),
        ),
      ),
    );
  }
}

/// Gold checkbox / switch row control.
class Toggle extends StatelessWidget {
  const Toggle({super.key, required this.value, required this.onChanged});
  final bool value;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return Switch(
      value: value,
      onChanged: onChanged,
      activeThumbColor: p.accentInk,
      activeTrackColor: p.gold,
      inactiveThumbColor: p.muted,
      inactiveTrackColor: p.surface2,
      trackOutlineColor: WidgetStatePropertyAll(p.line),
    );
  }
}

class GoldCheck extends StatelessWidget {
  const GoldCheck({super.key, required this.value, required this.onChanged});
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return Checkbox(
      value: value,
      onChanged: (v) => onChanged(v ?? false),
      activeColor: p.gold,
      checkColor: p.accentInk,
      side: BorderSide(color: p.faint, width: 1.5),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(3)),
      materialTapTargetSize: MaterialTapTargetSize.padded,
    );
  }
}

// ------------------------------------------------------------------ strip, brand mark, spinner

/// drawStrip (app.js:112-154): the gold piece map under every poster and row.
class Strip extends StatelessWidget {
  const Strip({super.key, required this.pieces, required this.progress, required this.status, this.height = 4});
  final List<double> pieces;
  final double progress;
  final String status;
  final double height;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    final main = status == 'seeding' ? p.sea : p.gold;
    final paused = status == 'paused' || status == 'queued';
    return SizedBox(
      height: height,
      width: double.infinity,
      child: Transform.flip(
        flipX: isRtl, // fills from the reading start
        child: CustomPaint(painter: _StripPainter(pieces, progress, main, paused ? p.faint : main, p.line, MediaQuery.devicePixelRatioOf(context))),
      ),
    );
  }
}

class _StripPainter extends CustomPainter {
  _StripPainter(this.cells, this.progress, this.main, this.fill, this.line, this.dpr);
  final List<double> cells;
  final double progress, dpr;
  final Color main, fill, line;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width, h = size.height;
    if (cells.isEmpty) {
      final r = Radius.circular(h / 2);
      canvas.drawRRect(RRect.fromRectAndRadius(Offset.zero & size, r), Paint()..color = line);
      if (progress > 0) {
        final pw = w * progress.clamp(0, 1);
        canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(0, 0, pw, h), Radius.circular(math.min(h / 2, pw / 2))), Paint()..color = fill);
      }
      return;
    }
    final n = cells.length;
    final cw = w / n;
    final gap = cw >= 3 ? 1 / dpr * dpr.clamp(1, 1) : 0.0;
    final base = Paint()..color = line;
    for (var i = 0; i < n; i++) {
      final rect = Rect.fromLTWH(i * cw, 0, cw - gap, h);
      canvas.drawRect(rect, base);
      if (cells[i] > 0) canvas.drawRect(rect, Paint()..color = main.withValues(alpha: .35 + .65 * cells[i]));
    }
  }

  @override
  bool shouldRepaint(_StripPainter o) =>
      o.progress != progress || o.main != main || o.fill != fill || o.line != line || !_same(o.cells, cells);

  static bool _same(List<double> a, List<double> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }
}

/// The brand mark (mark.js): a play triangle of download pieces. Pieces fill in left to right on
/// launch; the one missing piece breathes while anything downloads.
class BrandMark extends StatefulWidget {
  const BrandMark({super.key, this.size = 22, this.active = false});
  final double size;
  final bool active;

  @override
  State<BrandMark> createState() => _BrandMarkState();
}

class _BrandMarkState extends State<BrandMark> with SingleTickerProviderStateMixin {
  // [row, col, state]: 1 = downloaded, .5 = still arriving.
  static const _cells = [
    [0, 0, 1.0], [1, 0, 1.0], [1, 1, 1.0], [1, 2, 1.0], [2, 0, 1.0], [2, 1, 1.0], [2, 2, .5], [2, 3, 1.0],
    [3, 0, 1.0], [3, 1, 1.0], [3, 2, 1.0], [4, 0, 1.0],
  ];
  late final List<List<num>> _order = [..._cells]..sort((a, b) => a[1] != b[1] ? a[1].compareTo(b[1]) : a[0].compareTo(b[0]));
  late final Ticker _ticker = createTicker(_onTick);
  Duration _elapsed = Duration.zero;
  double _dim = .3;

  @override
  void initState() {
    super.initState();
    _ticker.start();
  }

  void _onTick(Duration d) {
    final ms = d.inMilliseconds;
    final target = widget.active ? .3 + .55 * (.5 - .5 * math.cos(2 * math.pi * (ms % 1600) / 1600)) : .3;
    _dim += (target - _dim) * .18;
    setState(() => _elapsed = d);
    final fillDone = ms > 11 * 35 + 260;
    if (fillDone && !widget.active && (_dim - .3).abs() < .01) _ticker.stop();
  }

  @override
  void didUpdateWidget(BrandMark old) {
    super.didUpdateWidget(old);
    if (widget.active && !_ticker.isActive) _ticker.start();
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduce = MediaQuery.disableAnimationsOf(context);
    return CustomPaint(
      size: Size.square(widget.size),
      painter: _MarkPainter(_order, reduce ? 100000 : _elapsed.inMilliseconds, reduce ? .3 : _dim, context.palette.gold),
    );
  }
}

class _MarkPainter extends CustomPainter {
  _MarkPainter(this.order, this.ms, this.dim, this.color);
  final List<List<num>> order;
  final int ms;
  final double dim;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final k = size.width / 40; // geometry in the desktop's 40×40 bitmap units
    const cell = 6.0, gap = 2.0;
    const ox = (40 - 30) / 2 + 30 * .07, oy = 1.0;
    for (var i = 0; i < order.length; i++) {
      final r = order[i][0].toDouble(), c = order[i][1].toDouble(), state = order[i][2].toDouble();
      final tt = ((ms - i * 35) / 260).clamp(0.0, 1.0);
      final e = 1 - math.pow(1 - tt, 3).toDouble();
      final s = cell * (.6 + .4 * e);
      final x = ox + c * (cell + gap) + (cell - s) / 2, y = oy + r * (cell + gap) + (cell - s) / 2;
      final a = (state == 1 ? 1.0 : dim) * e;
      canvas.drawRRect(
        RRect.fromRectAndRadius(Rect.fromLTWH(x * k, y * k, s * k, s * k), Radius.circular(1.6 * (s / 6) * k)),
        Paint()..color = color.withValues(alpha: a),
      );
    }
  }

  @override
  bool shouldRepaint(_MarkPainter o) => o.ms != ms || o.dim != dim || o.color != color;
}

/// 34px gold spinner (`.spinner`).
class Spinner extends StatelessWidget {
  const Spinner({super.key, this.size = 34});
  final double size;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return SizedBox.square(
      dimension: size,
      child: CircularProgressIndicator(strokeWidth: 3, color: p.gold, backgroundColor: p.gold.withValues(alpha: .2)),
    );
  }
}

// ------------------------------------------------------------------ sheets, menus, rows

/// Dialogs become bottom sheets on the phone: surface, 14px top radius, drag handle, h2 title.
Future<T?> showSheet<T>(BuildContext context, {required String title, required WidgetBuilder builder, List<Widget> actions = const [], bool tall = false, Widget? trailing}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: context.palette.surface,
    barrierColor: context.palette.backdrop,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(14))),
    builder: (ctx) {
      final p = ctx.palette;
      final body = Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(child: Container(margin: const EdgeInsets.only(top: 8, bottom: 6), width: 36, height: 4, decoration: BoxDecoration(color: p.line, borderRadius: BorderRadius.circular(2)))),
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 8, 14, 10),
            child: Row(children: [
              Expanded(child: Text(title, style: TextStyle(fontSize: Tokens.fsLg, fontWeight: FontWeight.w700, color: p.text))),
              ?trailing,
            ]),
          ),
          Flexible(child: Builder(builder: builder)),
          if (actions.isNotEmpty)
            Container(
              padding: EdgeInsets.fromLTRB(22, 12, 22, 12 + MediaQuery.viewInsetsOf(ctx).bottom),
              decoration: BoxDecoration(border: Border(top: BorderSide(color: p.line))),
              child: Wrap(alignment: WrapAlignment.end, spacing: 8, runSpacing: 8, children: actions),
            )
          else
            SizedBox(height: MediaQuery.viewInsetsOf(ctx).bottom),
        ],
      );
      return tall ? SizedBox(height: MediaQuery.sizeOf(ctx).height * .9, child: body) : body;
    },
  );
}

class MenuAction {
  const MenuAction(this.label, this.onTap, {this.icon, this.danger = false, this.checked = false});
  final String label;
  final VoidCallback onTap;
  final String? icon;
  final bool danger, checked;
}

/// Row "more" menus as an action sheet.
Future<void> showActions(BuildContext context, {String? title, required List<MenuAction?> actions}) {
  return showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    backgroundColor: context.palette.surface2,
    barrierColor: context.palette.backdrop,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(14))),
    builder: (ctx) {
      final p = ctx.palette;
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (title != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 6, 20, 10),
                child: Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: p.muted, fontSize: Tokens.fsSm, fontWeight: FontWeight.w600)),
              ),
            for (final a in actions)
              if (a == null)
                Divider(height: 9, thickness: 1, color: p.line, indent: 12, endIndent: 12)
              else
                InkWell(
                  onTap: () {
                    Navigator.pop(ctx);
                    a.onTap();
                  },
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                    child: Row(children: [
                      if (a.icon != null) ...[MIcon(a.icon!, size: 19, color: a.danger ? p.danger : p.muted), const SizedBox(width: 14)],
                      Expanded(child: Text(a.label, style: TextStyle(fontSize: Tokens.fsMd, color: a.danger ? p.danger : p.text))),
                      if (a.checked) MIcon('check', size: 17, color: p.gold),
                    ]),
                  ),
                ),
          ]),
        ),
      );
    },
  );
}

/// Centered confirm dialog (desktop Remove dialog style).
Future<T?> showChoice<T>(BuildContext context, {required String title, required String body, required List<(String, T, BtnKind)> choices}) {
  return showDialog<T>(
    context: context,
    barrierColor: context.palette.backdrop,
    builder: (ctx) {
      final p = ctx.palette;
      return Dialog(
        backgroundColor: p.surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: p.line)),
        insetPadding: const EdgeInsets.symmetric(horizontal: 16),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(22, 22, 22, 18),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text(title, style: TextStyle(fontSize: Tokens.fsLg, fontWeight: FontWeight.w700, color: p.text)),
            const SizedBox(height: 12),
            Text(body, style: TextStyle(color: p.muted, fontSize: Tokens.fsMd, height: 1.45)),
            const SizedBox(height: 20),
            for (final (label, value, kind) in choices.reversed)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Btn(label, kind: kind, inDialog: true, expand: true, onTap: () => Navigator.pop(ctx, value)),
              ),
          ]),
        ),
      );
    },
  );
}

/// `.pref-row`: label (+ help) on the start side, control on the end, hairline above.
class PrefRow extends StatelessWidget {
  const PrefRow({super.key, required this.label, this.help, this.trailing, this.below, this.onTap});
  final String label;
  final String? help;
  final Widget? trailing, below;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.palette;
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(border: Border(top: BorderSide(color: p.line))),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(label, style: TextStyle(fontWeight: FontWeight.w500, color: p.text, fontSize: Tokens.fsMd)),
                if (help != null) ...[
                  const SizedBox(height: 3),
                  Text(help!, style: TextStyle(color: p.muted, fontSize: Tokens.fsXs, height: 1.4)),
                ],
              ]),
            ),
            if (trailing != null) ...[const SizedBox(width: 16), trailing!],
          ]),
          if (below != null) ...[const SizedBox(height: 10), below!],
        ]),
      ),
    );
  }
}

/// `h3` section heading inside dialogs and Preferences.
class SectionHeading extends StatelessWidget {
  const SectionHeading(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 24, bottom: 6),
        child: Text(text, style: TextStyle(fontSize: Tokens.fsSm, fontWeight: FontWeight.w700, color: context.palette.muted)),
      );
}

/// Pill badge on posters ("Paused", "Done", "In library").
class Pill extends StatelessWidget {
  const Pill(this.text, {super.key, this.background = const Color(0x9E000000), this.color = Colors.white});
  final String text;
  final Color background, color;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(999)),
        child: Text(text, style: TextStyle(fontSize: Tokens.fsXs, fontWeight: FontWeight.w600, color: color)),
      );
}
