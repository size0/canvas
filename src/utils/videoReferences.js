export function selectVideoReferenceParents(imageParents, adRole) {
  if (adRole !== 'concept-video') return imageParents;

  // A storyboard board is a labelled contact sheet for planning and preview.
  // It is not a clean video frame, so sending it to an image-to-video model
  // makes the model crop/recompose the grid instead of animating the product.
  return imageParents.filter((parent) => parent.adRole !== 'storyboard-board');
}
