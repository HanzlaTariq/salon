import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../booking/booking_api.dart';
import 'discovery_api.dart';
import 'discovery_models.dart';
import 'qr_models.dart';
import '../reviews/review_api.dart';
import 'salon_profile_screen.dart';

/// Scan a salon's QR code (or type the code printed on its poster) and open the salon. Works without location.
/// Camera permission is asked by the system when this screen opens; if it is denied, typing the code still works.
class ScanSalonScreen extends StatefulWidget {
  const ScanSalonScreen({super.key, required this.api, required this.bookingApi, this.reviewApi});

  final DiscoveryApi api;
  final BookingApi bookingApi;
  final ReviewApi? reviewApi;

  @override
  State<ScanSalonScreen> createState() => _ScanSalonScreenState();
}

class _ScanSalonScreenState extends State<ScanSalonScreen> {
  final MobileScannerController _camera = MobileScannerController(formats: const [BarcodeFormat.qrCode], detectionSpeed: DetectionSpeed.noDuplicates);
  final TextEditingController _typed = TextEditingController();
  bool _resolving = false;
  String? _error;

  @override
  void dispose() {
    _camera.dispose();
    _typed.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_resolving) return;
    for (final b in capture.barcodes) {
      final raw = b.rawValue;
      if (raw != null) {
        _open(raw);
        return;
      }
    }
  }

  Future<void> _open(String raw) async {
    final code = parseSalonCode(raw);
    if (code == null) {
      setState(() => _error = 'This is not a salon QR code.');
      return;
    }
    setState(() {
      _resolving = true;
      _error = null;
    });
    try {
      final scanned = await widget.api.resolveCode(code);
      if (!mounted) return;
      // Only the fields the profile screen needs; everything else is loaded from the server there.
      final card = SalonCard.fromJson({
        'id': scanned.salonId, 'name': scanned.name, 'salonType': scanned.salonType, 'city': scanned.city, 'area': scanned.area,
      });
      await Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(builder: (_) => SalonProfileScreen(api: widget.api, bookingApi: widget.bookingApi, card: card, reviewApi: widget.reviewApi)),
      );
    } on ApiException catch (e) {
      if (mounted) {
        setState(() => _error = e.statusCode == 404 ? 'This salon is not available right now.' : e.message);
      }
    } finally {
      if (mounted) setState(() => _resolving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan salon QR')),
      body: SafeArea(
        child: Column(children: [
          Expanded(
            child: Stack(fit: StackFit.expand, children: [
              MobileScanner(controller: _camera, onDetect: _onDetect),
              if (_resolving) const ColoredBox(color: Color(0x88000000), child: LoadingView(label: 'Opening salon…')),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text('Point the camera at the salon\'s QR code, or type the code printed on the poster.', style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: AppSpacing.sm),
              Row(children: [
                Expanded(
                  child: TextField(
                    controller: _typed,
                    maxLength: 10,
                    textCapitalization: TextCapitalization.none,
                    autocorrect: false,
                    enableSuggestions: false,
                    textInputAction: TextInputAction.go,
                    onSubmitted: _resolving ? null : _open,
                    decoration: const InputDecoration(labelText: 'Salon code', counterText: ''),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                FilledButton(onPressed: _resolving ? null : () => _open(_typed.text), child: const Text('Open')),
              ]),
              if (_error != null) ...[
                const SizedBox(height: AppSpacing.sm),
                Text(_error!, style: const TextStyle(color: AppColors.danger)),
              ],
            ]),
          ),
        ]),
      ),
    );
  }
}
