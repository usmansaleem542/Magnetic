// The desktop's SVG sprite (web-app/renderer/index.html), drawn with the same paths.

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

const _s = 'stroke="currentColor"';
const _round = 'stroke-linecap="round" stroke-linejoin="round"';

const Map<String, String> _paths = {
  'play': '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  'pause': '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/>',
  'resume': '<path d="M12 4v10m0 0l-4-4m4 4l4-4M5 19h14" fill="none" $_s stroke-width="2" $_round/>',
  'more': '<circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/>',
  'chevron': '<path d="M9 6l6 6-6 6" fill="none" $_s stroke-width="2" $_round/>',
  'back': '<path d="M15 6l-6 6 6 6" fill="none" $_s stroke-width="2" $_round/>',
  'gear': '<path d="M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z" fill="none" $_s stroke-width="1.8"/><path d="M19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7.6 7.6 0 01-1.9 1.1L15 20.5h-4l-.3-2a7.6 7.6 0 01-1.9-1.1l-1.9.7-2-3.4 1.6-1.2a7.4 7.4 0 010-2.2L4.9 10l2-3.4 1.9.7a7.6 7.6 0 011.9-1.1L11 4.2h4l.3 2a7.6 7.6 0 011.9 1.1l1.9-.7 2 3.4-1.6 1.2a7.4 7.4 0 010 2.3z" fill="none" $_s stroke-width="1.6" stroke-linejoin="round"/>',
  'file': '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z M14 3v5h5" fill="none" $_s stroke-width="1.8" stroke-linejoin="round"/>',
  'music': '<path d="M9 18V6l11-2v12" fill="none" $_s stroke-width="1.8" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="none" $_s stroke-width="1.8"/><circle cx="17.5" cy="16" r="2.5" fill="none" $_s stroke-width="1.8"/>',
  'share': '<path d="M12 15V4m0 0L8 8m4-4l4 4M5 14v4a2 2 0 002 2h10a2 2 0 002-2v-4" fill="none" $_s stroke-width="1.8" $_round/>',
  'search': '<circle cx="11" cy="11" r="6.5" fill="none" $_s stroke-width="1.8"/><path d="M16 16l4 4" $_s stroke-width="1.8" stroke-linecap="round"/>',
  'volume': '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11" fill="none" $_s stroke-width="1.8" stroke-linecap="round"/>',
  'mute': '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M16 9.5l5 5m0-5l-5 5" fill="none" $_s stroke-width="1.8" stroke-linecap="round"/>',
  'full': '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" $_s stroke-width="1.8" stroke-linecap="round"/>',
  'pip': '<rect x="3" y="5" width="18" height="14" rx="2" fill="none" $_s stroke-width="1.8"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor"/>',
  'cc': '<rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" $_s stroke-width="1.8"/><path d="M10.5 10.2a2.3 2.3 0 100 3.6M17 10.2a2.3 2.3 0 100 3.6" fill="none" $_s stroke-width="1.6" stroke-linecap="round"/>',
  'cast': '<path d="M3 9V7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2h-5" fill="none" $_s stroke-width="1.8" stroke-linecap="round"/><path d="M3 13a6 6 0 016 6M3 16.5a2.5 2.5 0 012.5 2.5" fill="none" $_s stroke-width="1.8" stroke-linecap="round"/><circle cx="3.3" cy="19" r="1.1" fill="currentColor"/>',
  'grid': '<rect x="4" y="4" width="7" height="7" rx="1.5" fill="none" $_s stroke-width="1.8"/><rect x="13" y="4" width="7" height="7" rx="1.5" fill="none" $_s stroke-width="1.8"/><rect x="4" y="13" width="7" height="7" rx="1.5" fill="none" $_s stroke-width="1.8"/><rect x="13" y="13" width="7" height="7" rx="1.5" fill="none" $_s stroke-width="1.8"/>',
  'rows': '<rect x="4" y="5" width="16" height="5" rx="1.5" fill="none" $_s stroke-width="1.8"/><rect x="4" y="14" width="16" height="5" rx="1.5" fill="none" $_s stroke-width="1.8"/>',
  'minus': '<path d="M6 12h12" $_s stroke-width="2" stroke-linecap="round"/>',
  'plus': '<path d="M6 12h12M12 6v12" $_s stroke-width="2" stroke-linecap="round"/>',
  'close': '<path d="M7.76 7.76l8.48 8.48M16.24 7.76l-8.48 8.48" $_s stroke-width="2" stroke-linecap="round"/>',
  'next': '<path d="M6 6l9 6-9 6z" fill="currentColor"/><path d="M17 6v12" $_s stroke-width="2" stroke-linecap="round"/>',
  'prev': '<path d="M18 6l-9 6 9 6z" fill="currentColor"/><path d="M7 6v12" $_s stroke-width="2" stroke-linecap="round"/>',
  'list': '<path d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01" fill="none" $_s stroke-width="2" stroke-linecap="round"/>',
  'compass': '<circle cx="12" cy="12" r="8.5" fill="none" $_s stroke-width="1.8"/><path d="M15.2 8.8l-1.9 4.5-4.5 1.9 1.9-4.5z" fill="currentColor" $_s stroke-width="1.2" stroke-linejoin="round"/>',
  'external': '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4" fill="none" $_s stroke-width="1.8" $_round/>',
  // Phone-only additions in the same style.
  'sort': '<path d="M4 7h16M4 12h11M4 17h6" fill="none" $_s stroke-width="2" stroke-linecap="round"/>',
  'folder': '<path d="M3.5 7.5a2 2 0 012-2h4l2 2.5h7a2 2 0 012 2v7.5a2 2 0 01-2 2h-13a2 2 0 01-2-2z" fill="none" $_s stroke-width="1.8" stroke-linejoin="round"/>',
  'paste': '<rect x="5" y="5" width="14" height="16" rx="2" fill="none" $_s stroke-width="1.8"/><path d="M9 3.5h6v3H9z" fill="none" $_s stroke-width="1.8" stroke-linejoin="round"/>',
  'lock': '<rect x="5" y="11" width="14" height="9" rx="2" fill="none" $_s stroke-width="1.8"/><path d="M8.5 11V8a3.5 3.5 0 017 0v3" fill="none" $_s stroke-width="1.8"/>',
  'rewind': '<path d="M11 7l-6 5 6 5zM19 7l-6 5 6 5z" fill="currentColor"/>',
  'forward': '<path d="M13 7l6 5-6 5zM5 7l6 5-6 5z" fill="currentColor"/>',
  'check': '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" $_s stroke-width="2" $_round/>',
};

class MIcon extends StatelessWidget {
  const MIcon(this.name, {super.key, this.size = 18, this.color, this.mirror = false});
  final String name;
  final double size;
  final Color? color;

  /// Mirror in right-to-left layouts (chevrons, back).
  final bool mirror;

  @override
  Widget build(BuildContext context) {
    final c = color ?? IconTheme.of(context).color ?? DefaultTextStyle.of(context).style.color ?? Colors.white;
    Widget icon = SvgPicture.string(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${_paths[name]}</svg>',
      width: size,
      height: size,
      theme: SvgTheme(currentColor: c),
    );
    if (mirror && Directionality.of(context) == TextDirection.rtl) {
      icon = Transform.flip(flipX: true, child: icon);
    }
    return icon;
  }
}
