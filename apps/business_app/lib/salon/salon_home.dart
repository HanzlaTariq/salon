import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';
import 'package:image_picker/image_picker.dart';

import 'salon_api.dart';
import 'salon_form.dart';
import 'salon_models.dart';

/// Owner home for Phase 3: register the salon, upload documents/photos, submit, and follow the review status.
class SalonHome extends StatefulWidget {
  const SalonHome({super.key, required this.repository, required this.api});

  final AuthRepository repository;
  final SalonApi api;

  @override
  State<SalonHome> createState() => _SalonHomeState();
}

class _SalonHomeState extends State<SalonHome> {
  final _picker = ImagePicker();
  SalonOverview? _overview;
  bool _loading = true;
  bool _busy = false;
  ApiException? _loadError;
  String? _actionError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final o = await widget.api.getMine();
      if (mounted) setState(() => _overview = o);
    } on ApiException catch (e) {
      if (mounted) setState(() => _loadError = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openForm({SalonProfile? existing}) async {
    final result = await Navigator.of(context).push<SalonOverview>(
      MaterialPageRoute(builder: (_) => SalonFormScreen(api: widget.api, existing: existing)),
    );
    if (result != null && mounted) setState(() => _overview = result);
  }

  Future<ImageSource?> _chooseSource() => showModalBottomSheet<ImageSource>(
        context: context,
        builder: (ctx) => SafeArea(
          child: Wrap(children: [
            ListTile(leading: const Icon(Icons.photo_camera_outlined), title: const Text('Take a photo'), onTap: () => Navigator.pop(ctx, ImageSource.camera)),
            ListTile(leading: const Icon(Icons.photo_library_outlined), title: const Text('Choose from gallery'), onTap: () => Navigator.pop(ctx, ImageSource.gallery)),
          ]),
        ),
      );

  Future<void> _upload(String kind, String docType) async {
    final source = await _chooseSource();
    if (source == null) return;
    setState(() {
      _busy = true;
      _actionError = null;
    });
    try {
      final picked = await _picker.pickImage(source: source, maxWidth: 2400, imageQuality: 90);
      if (picked == null) return;
      final bytes = await picked.readAsBytes();
      await widget.api.uploadFile(kind: kind, docType: docType, bytes: bytes, filename: picked.name);
      await _refresh();
    } on ApiException catch (e) {
      setState(() => _actionError = e.message);
    } catch (_) {
      setState(() => _actionError = 'Could not read the selected image. Please try another one.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete(SalonFile f) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete this file?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true) return;
    setState(() {
      _busy = true;
      _actionError = null;
    });
    try {
      await widget.api.deleteFile(f.id);
      await _refresh();
    } on ApiException catch (e) {
      setState(() => _actionError = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _submit() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Submit for approval?'),
        content: const Text('You cannot edit your salon while it is under review.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Not yet')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Submit')),
        ],
      ),
    );
    if (ok != true) return;
    setState(() {
      _busy = true;
      _actionError = null;
    });
    try {
      final o = await widget.api.submit();
      if (mounted) setState(() => _overview = o);
    } on ApiException catch (e) {
      setState(() => _actionError = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refresh() async {
    final o = await widget.api.getMine();
    if (mounted) setState(() => _overview = o);
  }

  @override
  Widget build(BuildContext context) {
    final user = widget.repository.session?.user;
    return Scaffold(
      appBar: AppBar(
        title: const Text('My salon'),
        actions: [
          IconButton(tooltip: 'Refresh', icon: const Icon(Icons.refresh), onPressed: _loading ? null : _load),
          IconButton(tooltip: 'Sign out', icon: const Icon(Icons.logout), onPressed: widget.repository.logout),
        ],
      ),
      body: SafeArea(child: _body(user?.fullName ?? '')),
    );
  }

  Widget _body(String name) {
    if (_loading) return const LoadingView(label: 'Loading your salon...');
    if (_loadError != null) {
      return ErrorView(message: _loadError!.message, requestId: _loadError!.requestId, onRetry: _load);
    }
    final o = _overview;
    if (o == null) {
      return EmptyView(
        icon: Icons.storefront_outlined,
        title: 'Welcome, $name',
        message: 'Register your salon to start receiving bookings. It is reviewed before customers can see it.',
        action: FilledButton(onPressed: () => _openForm(), child: const Text('Register my salon')),
      );
    }
    final s = o.salon;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.xl),
        children: [
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(s.name, style: Theme.of(context).textTheme.headlineSmall),
                const SizedBox(height: AppSpacing.xs),
                Text('${s.city}, ${s.area}', style: Theme.of(context).textTheme.bodyMedium),
                const SizedBox(height: AppSpacing.lg),
                _StatusCard(salon: s),
                if (_actionError != null) ...[
                  const SizedBox(height: AppSpacing.md),
                  Text(_actionError!, style: const TextStyle(color: AppColors.danger)),
                ],
                if (o.canEdit) ...[
                  const SizedBox(height: AppSpacing.xl),
                  Text('Documents', style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: AppSpacing.xs),
                  Text('Photos of your documents are stored privately and seen only by our review team.', style: Theme.of(context).textTheme.bodySmall),
                  for (final d in o.requiredDocuments) _slot(label: documentLabels[d] ?? d, file: o.fileOf(d), onUpload: () => _upload('DOCUMENT', d)),
                  const SizedBox(height: AppSpacing.lg),
                  Text('Salon photos (${o.photoCount}/${o.minPhotos} required)', style: Theme.of(context).textTheme.titleMedium),
                  _slot(label: 'Cover photo', file: o.fileOf('COVER'), onUpload: () => _upload('PHOTO', 'COVER')),
                  for (final f in o.files.where((f) => f.docType == 'GALLERY'))
                    ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.image_outlined), title: const Text('Gallery photo'), trailing: IconButton(tooltip: 'Delete photo', icon: const Icon(Icons.delete_outline), onPressed: _busy ? null : () => _delete(f))),
                  Align(alignment: Alignment.centerLeft, child: TextButton.icon(onPressed: _busy ? null : () => _upload('PHOTO', 'GALLERY'), icon: const Icon(Icons.add_photo_alternate_outlined), label: const Text('Add gallery photo'))),
                  const SizedBox(height: AppSpacing.xl),
                  OutlinedButton(onPressed: _busy ? null : () => _openForm(existing: s), child: const Text('Edit salon details')),
                  const SizedBox(height: AppSpacing.md),
                  FilledButton(
                    onPressed: (_busy || !o.canSubmit) ? null : _submit,
                    child: _busy ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2)) : Text(s.status == 'REJECTED' ? 'Resubmit for approval' : 'Submit for approval'),
                  ),
                  if (!o.canSubmit)
                    Padding(
                      padding: const EdgeInsets.only(top: AppSpacing.sm),
                      child: Text(
                        'Still needed: ${[...o.missingDocuments.map((d) => documentLabels[d] ?? d), if (o.missingPhotos > 0) '${o.missingPhotos} photo(s)'].join(', ')}',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                ],
              ]),
            ),
          ),
        ],
      ),
    );
  }

  Widget _slot({required String label, required SalonFile? file, required VoidCallback onUpload}) {
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(file != null ? Icons.check_circle : Icons.radio_button_unchecked, color: file != null ? AppColors.emerald : AppColors.mutedText),
      title: Text(label),
      subtitle: Text(file != null ? 'Uploaded' : 'Required'),
      trailing: TextButton(onPressed: _busy ? null : onUpload, child: Text(file != null ? 'Replace' : 'Upload')),
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.salon});
  final SalonProfile salon;

  @override
  Widget build(BuildContext context) {
    late final IconData icon;
    late final Color color;
    late final String title;
    late final String text;
    switch (salon.status) {
      case 'PENDING':
        icon = Icons.hourglass_top;
        color = AppColors.warning;
        title = 'Under review';
        text = 'We are reviewing your application. You will get an e-mail when there is a decision.';
      case 'APPROVED':
        icon = Icons.verified_outlined;
        color = AppColors.emerald;
        title = 'Approved';
        text = 'Your salon is live and visible to customers. Services, staff and bookings arrive in the next releases.';
      case 'REJECTED':
        icon = Icons.error_outline;
        color = AppColors.danger;
        title = 'Changes needed';
        text = salon.rejectionReason ?? 'Please correct your details and submit again.';
      case 'SUSPENDED':
        icon = Icons.block;
        color = AppColors.danger;
        title = 'Suspended';
        text = salon.suspendedReason ?? 'Please contact support.';
      default:
        icon = Icons.edit_note;
        color = AppColors.mutedText;
        title = 'Draft';
        text = 'Complete the details below, then submit for approval.';
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(icon, color: color),
          const SizedBox(width: AppSpacing.md),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: Theme.of(context).textTheme.titleMedium?.copyWith(color: color)),
            const SizedBox(height: AppSpacing.xs),
            Text(text),
          ])),
        ]),
      ),
    );
  }
}
