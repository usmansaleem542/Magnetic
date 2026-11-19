import 'package:flutter_test/flutter_test.dart';
import 'package:magnetic/l10n.dart';

void main() {
  tearDown(() => L10n.use('en', const {}));

  test('English returns the key with placeholders filled', () {
    L10n.use('en', const {});
    expect(t('{m} min left', {'m': 5}), '5 min left');
    expect(isRtl, isFalse);
  });

  test('Arabic looks the English text up and keeps unknown keys in English', () {
    L10n.use('ar', const {'Down {speed}': 'تنزيل {speed}'});
    expect(t('Down {speed}', {'speed': '1 MB/s'}), 'تنزيل 1 MB/s');
    expect(t('Not translated'), 'Not translated');
    expect(isRtl, isTrue);
  });

  test('unknown placeholders are left as they are', () {
    expect(t('{a} and {b}', {'a': 1}), '1 and {b}');
  });

  test('ltr isolates values only in Arabic', () {
    expect(ltr('8.7 MB'), '8.7 MB');
    L10n.use('ar', const {});
    expect(ltr('8.7 MB'), '\u20668.7 MB\u2069');
  });

  test('resolveLanguage follows the system for "system"', () {
    expect(resolveLanguage('en', 'ar-AE'), 'en');
    expect(resolveLanguage('system', 'ar_AE'), 'ar');
    expect(resolveLanguage('system', 'ar'), 'ar');
    expect(resolveLanguage('system', 'arn-CL'), 'en');
    expect(resolveLanguage('system', 'en-GB'), 'en');
  });
}
