import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'review_models.dart';

/// Read-only stars. The numeric value is always available to screen readers.
class StarRow extends StatelessWidget {
  const StarRow({super.key, required this.rating, this.size = 16});
  final double? rating;
  final double size;

  @override
  Widget build(BuildContext context) {
    final value = rating ?? 0;
    return Semantics(
      label: rating == null ? 'No rating' : 'Rated ${rating!.toStringAsFixed(1)} out of 5',
      child: ExcludeSemantics(
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          for (var i = 1; i <= 5; i++)
            Icon(value >= i - 0.25 ? Icons.star_rounded : (value >= i - 0.75 ? Icons.star_half_rounded : Icons.star_outline_rounded), size: size, color: AppColors.gold),
        ]),
      ),
    );
  }
}

/// Tappable stars (touch targets of 44 px). Tapping the selected star again clears it when [clearable].
class StarPicker extends StatelessWidget {
  const StarPicker({super.key, required this.label, required this.value, required this.onChanged, this.clearable = false});
  final String label;
  final int? value;
  final ValueChanged<int?> onChanged;
  final bool clearable;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      label: '$label, ${value == null ? 'not rated' : '$value out of 5'}',
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        for (var i = 1; i <= 5; i++)
          IconButton(
            tooltip: '$i ${i == 1 ? 'star' : 'stars'}',
            constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
            padding: EdgeInsets.zero,
            icon: Icon((value ?? 0) >= i ? Icons.star_rounded : Icons.star_outline_rounded, size: 32, color: AppColors.gold),
            onPressed: () => onChanged(clearable && value == i ? null : i),
          ),
      ]),
    );
  }
}

/// Average, count and a bar per star.
class RatingSummaryCard extends StatelessWidget {
  const RatingSummaryCard({super.key, required this.summary});
  final RatingSummary summary;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (summary.count == 0) {
      return Card(child: Padding(padding: const EdgeInsets.all(AppSpacing.lg), child: Text('No reviews yet. Be the first to share your visit.', style: theme.textTheme.bodyMedium)));
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
          Column(mainAxisSize: MainAxisSize.min, children: [
            Text(summary.average?.toStringAsFixed(1) ?? '-', style: theme.textTheme.displaySmall),
            StarRow(rating: summary.average),
            const SizedBox(height: AppSpacing.xs),
            Text('${summary.count} ${summary.count == 1 ? 'review' : 'reviews'}', style: theme.textTheme.bodySmall),
          ]),
          const SizedBox(width: AppSpacing.xl),
          Expanded(
            child: Column(children: [
              for (var s = 5; s >= 1; s--)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Semantics(
                    label: '$s stars: ${summary.distribution[s] ?? 0} reviews',
                    child: ExcludeSemantics(
                      child: Row(children: [
                        SizedBox(width: 14, child: Text('$s', style: theme.textTheme.bodySmall)),
                        const SizedBox(width: AppSpacing.sm),
                        Expanded(child: ClipRRect(borderRadius: BorderRadius.circular(4), child: LinearProgressIndicator(value: summary.share(s), minHeight: 8, color: AppColors.gold, backgroundColor: AppColors.sand))),
                      ]),
                    ),
                  ),
                ),
            ]),
          ),
        ]),
      ),
    );
  }
}

String reviewDate(DateTime? d) {
  if (d == null) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  final l = d.toLocal();
  return '${l.day} ${months[l.month - 1]} ${l.year}';
}

/// One review card (public view). The salon's response is shown under it.
class PublicReviewCard extends StatelessWidget {
  const PublicReviewCard({super.key, required this.review});
  final PublicReview review;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(review.authorName, style: theme.textTheme.titleSmall, overflow: TextOverflow.ellipsis)),
            Text(reviewDate(review.createdAt) + (review.edited ? ' · edited' : ''), style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText)),
          ]),
          const SizedBox(height: AppSpacing.xs),
          StarRow(rating: review.rating.toDouble()),
          if (review.staffRating != null && review.staffName != null) ...[
            const SizedBox(height: AppSpacing.xs),
            Row(children: [Text('${review.staffName}  ', style: theme.textTheme.bodySmall), StarRow(rating: review.staffRating!.toDouble(), size: 13)]),
          ],
          if (review.comment != null) ...[const SizedBox(height: AppSpacing.sm), Text(review.comment!, style: theme.textTheme.bodyMedium)],
          if (review.services.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.sm),
            Text(review.services.map((s) => '${s.name} ${s.rating}/5').join(' · '), style: theme.textTheme.bodySmall?.copyWith(color: AppColors.mutedText)),
          ],
          if (review.response != null) ...[
            const SizedBox(height: AppSpacing.md),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(AppSpacing.md),
              decoration: BoxDecoration(color: AppColors.sand, borderRadius: BorderRadius.circular(AppRadius.input)),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Response from the salon', style: theme.textTheme.labelMedium?.copyWith(color: AppColors.ink)),
                const SizedBox(height: AppSpacing.xs),
                Text(review.response!.text, style: theme.textTheme.bodyMedium?.copyWith(color: AppColors.ink)),
              ]),
            ),
          ],
        ]),
      ),
    );
  }
}
