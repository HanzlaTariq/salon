import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'review_api.dart';
import 'review_models.dart';
import 'review_widgets.dart';

/// Write a review for a completed visit, or edit your own review (within the server's 7-day window).
/// Pops with `true` when something was saved. All rules (completed visit, 30 days, one review per visit) are enforced by the server.
class WriteReviewScreen extends StatefulWidget {
  const WriteReviewScreen.create({super.key, required this.api, required PendingReview pending})
      : pending = pending,
        existing = null;
  const WriteReviewScreen.edit({super.key, required this.api, required MyReview review})
      : existing = review,
        pending = null;

  final ReviewApi api;
  final PendingReview? pending;
  final MyReview? existing;

  @override
  State<WriteReviewScreen> createState() => _WriteReviewScreenState();
}

class _WriteReviewScreenState extends State<WriteReviewScreen> {
  late int? _salon = widget.existing?.rating;
  late int? _staff = widget.existing?.staffRating;
  late final TextEditingController _comment = TextEditingController(text: widget.existing?.comment ?? '');
  final Map<String, int> _services = {};
  bool _saving = false;
  String? _error;
  bool _touched = false;

  bool get _editing => widget.existing != null;
  String get _salonName => widget.existing?.salonName ?? widget.pending!.salonName;
  String? get _staffName => widget.existing?.staffName ?? widget.pending?.staffName;

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _touched = true);
    if (!isValidStars(_salon) || commentProblem(_comment.text) != null) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      if (_editing) {
        await widget.api.update(widget.existing!.id, salonRating: _salon!, staffRating: _staff, comment: _comment.text);
      } else {
        await widget.api.create(
          appointmentId: widget.pending!.appointmentId,
          salonRating: _salon!,
          staffRating: _staff,
          comment: _comment.text,
          serviceRatings: _services,
        );
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(_editing ? 'Your review was updated.' : 'Thank you! Your review is now public.')));
      Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Something went wrong. Please try again.');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final commentError = commentProblem(_comment.text);
    return Scaffold(
      appBar: AppBar(title: Text(_editing ? 'Edit your review' : 'Rate your visit')),
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.all(AppSpacing.lg), children: [
          Text(_salonName, style: theme.textTheme.titleLarge),
          if (widget.pending?.visitAt != null) Text(reviewDate(widget.pending!.visitAt), style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText)),
          const SizedBox(height: AppSpacing.xl),
          Text('How was the salon?', style: theme.textTheme.titleMedium),
          StarPicker(label: 'Salon rating', value: _salon, onChanged: (v) => setState(() => _salon = v)),
          if (_touched && !isValidStars(_salon)) Text('Please choose 1 to 5 stars.', style: theme.textTheme.bodySmall?.copyWith(color: AppColors.danger)),
          if (_staffName != null && _staffName!.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.lg),
            Text('How was $_staffName? (optional)', style: theme.textTheme.titleMedium),
            StarPicker(label: 'Staff rating', value: _staff, clearable: true, onChanged: (v) => setState(() => _staff = v)),
          ],
          if (!_editing && widget.pending!.services.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.lg),
            Text('Rate the services (optional)', style: theme.textTheme.titleMedium),
            for (final s in widget.pending!.services) ...[
              const SizedBox(height: AppSpacing.xs),
              Text(s.name, style: theme.textTheme.bodyMedium),
              StarPicker(
                label: s.name,
                value: _services[s.serviceId],
                clearable: true,
                onChanged: (v) => setState(() {
                  if (v == null) {
                    _services.remove(s.serviceId);
                  } else {
                    _services[s.serviceId] = v;
                  }
                }),
              ),
            ],
          ],
          const SizedBox(height: AppSpacing.lg),
          TextField(
            controller: _comment,
            maxLines: 5,
            minLines: 3,
            maxLength: kReviewCommentMax,
            textCapitalization: TextCapitalization.sentences,
            onChanged: (_) => setState(() {}),
            decoration: InputDecoration(labelText: 'Your review (optional)', alignLabelWithHint: true, errorText: commentError),
          ),
          if (_error != null) ...[
            const SizedBox(height: AppSpacing.sm),
            Semantics(liveRegion: true, child: Text(_error!, style: theme.textTheme.bodyMedium?.copyWith(color: AppColors.danger))),
          ],
          const SizedBox(height: AppSpacing.lg),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: _saving ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2)) : Text(_editing ? 'Save changes' : 'Post review'),
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            _editing ? 'You can edit a review for 7 days after you wrote it.' : 'Your review shows your first name and the initial of your last name. You can edit it for 7 days.',
            style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText),
          ),
        ]),
      ),
    );
  }
}
